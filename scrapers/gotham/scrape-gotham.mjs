import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, saveShows } from "../../db.mjs";

const URL = "https://www.gothamcomedyclub.com/calendar";

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return "";
  return next;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeWs(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMonthYear(line) {
  const m = normalizeWs(line).match(
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})$/i
  );
  if (!m) return null;
  const monthName = m[1].toLowerCase();
  const year = Number(m[2]);
  const monthMap = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  };
  const month = monthMap[monthName];
  if (month == null || !Number.isFinite(year)) return null;
  return { year, month };
}

function formatYYYYMMDD({ year, month, day }) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTimeToStandard(line) {
  // "08:00 PM" -> "8:00 pm"
  const m = normalizeWs(line).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  const hh = String(Number(m[1])); // removes leading 0
  const mm = m[2];
  const ap = m[3].toLowerCase();
  return `${hh}:${mm} ${ap}`;
}

function parseGothamFromText(pageText) {
  const lines = String(pageText || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => normalizeWs(l))
    .filter(Boolean);

  let currentMonthYear = null; // {year, month}
  const shows = [];

  for (let i = 0; i < lines.length; i++) {
    const maybeMY = parseMonthYear(lines[i]);
    if (maybeMY) {
      currentMonthYear = maybeMY;
      continue;
    }

    // day number line
    const dayMatch = lines[i].match(/^(\d{1,2})$/);
    if (!dayMatch || !currentMonthYear) continue;
    const day = Number(dayMatch[1]);
    if (!(day >= 1 && day <= 31)) continue;

    const showName = lines[i + 1];
    const timeLine = lines[i + 2];
    const ctaLine = lines[i + 3];

    const time = parseTimeToStandard(timeLine);
    if (!showName || !time) continue;
    if (!ctaLine || !/get tickets/i.test(ctaLine)) continue;

    shows.push({
      source: "gotham",
      date: formatYYYYMMDD({ ...currentMonthYear, day }),
      time,
      venue: "Gotham Comedy Club",
      comedians: [{ name: showName, credits: "" }]
    });
  }

  return shows;
}

const headful = hasFlag("headful");
const chromeArg = argValue("chrome");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const guessChromeExecutablePath = async () => {
  const candidates = [
    chromeArg,
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // keep going
    }
  }
  return null;
};

const chromePath = await guessChromeExecutablePath();

const browser = await puppeteer.launch({
  headless: headful ? false : "new",
  ...(chromePath ? { executablePath: chromePath } : {}),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(URL, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 120000 });

  // Wait for calendar-ish content to appear.
  await page.waitForFunction(
    () => {
      const t = (document.body?.innerText || "").toLowerCase();
      return (
        t.includes("calendar") ||
        t.includes("show") ||
        t.includes("ticket") ||
        t.includes("tickets") ||
        document.querySelectorAll("a, button, [role='button']").length > 10
      );
    },
    { timeout: 120000 }
  );

  // Hard wait fallback.
  await sleep(5000);

  // Best-effort expand of collapsible sections (same pattern as NYCC):
  await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const clickAll = (els) => {
      for (const el of els) {
        try {
          if (el instanceof HTMLElement) el.click();
        } catch {
          // ignore
        }
      }
    };

    clickAll(Array.from(document.querySelectorAll('[aria-expanded="false"]')).filter(isVisible));

    const candidates = Array.from(
      document.querySelectorAll("button, a, div[role='button'], span[role='button']")
    ).filter(isVisible);

    const shouldClick = (txt) => {
      const t = (txt || "").replace(/\u00a0/g, " ").trim().toLowerCase();
      if (!t) return false;
      return (
        t === "+" ||
        t === "more" ||
        t === "expand" ||
        t === "show more" ||
        t === "view more" ||
        t === "details" ||
        t === "lineup"
      );
    };

    clickAll(candidates.filter((el) => shouldClick(el.textContent)));
  });

  await sleep(1500);

  const pageText = await page.evaluate(() => document.body?.innerText || "");
  const shows = parseGothamFromText(pageText);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outPath = path.join(__dirname, "gotham-lineup.json");
  await fs.writeFile(outPath, JSON.stringify(shows, null, 2), "utf8");
  console.log(`Wrote Gotham lineup JSON to: ${outPath}`);

  const db = openDb();
  try {
    const { inserted, skipped } = saveShows(db, shows);
    console.log(`Saved to spotlight.db: inserted ${inserted}, skipped ${skipped}`);
  } finally {
    db.close();
  }
} finally {
  await browser.close();
}

