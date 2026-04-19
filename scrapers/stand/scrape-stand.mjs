import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, saveShows } from "../../db.mjs";

const URL = "https://thestandnyc.com/shows";

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

function monthIndexFromName(monthName) {
  const m = monthName.toLowerCase();
  const map = {
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
  return map[m] ?? null;
}

/** Pick calendar year for a month/day given the page rarely includes year in text. */
function inferYearForMonthDay(month, day, now = new Date()) {
  let year = now.getFullYear();
  const candidate = new Date(year, month, day);
  const msPerDay = 86400000;
  const diffDays = (candidate - now) / msPerDay;
  if (diffDays > 200) year -= 1;
  if (diffDays < -200) year += 1;
  return year;
}

function formatYYYYMMDD(year, month, day) {
  const d = new Date(year, month, day);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime12h(hh24, mm) {
  const ap = hh24 >= 12 ? "pm" : "am";
  let h = hh24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ap}`;
}

function parseMetaLine(line) {
  const re =
    /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\s*\|\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+(.+)$/i;
  const m = normalizeWs(line).match(re);
  if (!m) return null;

  const month = monthIndexFromName(m[1]);
  const day = Number(m[2]);
  if (month == null || !(day >= 1 && day <= 31)) return null;

  let hh = Number(m[3]);
  const mm = Number(m[4]);
  const ap = m[5].toUpperCase();
  const tail = normalizeWs(m[6]);
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;

  const upperTail = tail.toUpperCase();
  let venue = "The Stand - Main Room";
  if (upperTail.includes("UPSTAIRS")) venue = "The Stand - Upstairs";
  else if (upperTail.includes("MAIN ROOM")) venue = "The Stand - Main Room";

  const year = inferYearForMonthDay(month, day);
  const date = formatYYYYMMDD(year, month, day);
  const time = formatTime12h(hh, mm);

  return { date, time, venue };
}

function isNoiseTitle(line) {
  const l = line.toLowerCase();
  return (
    l === "shows" ||
    l === "the stand" ||
    l.startsWith("http") ||
    l === "buy tickets" ||
    l === "sold out" ||
    l === "more info" ||
    l === "the lineup"
  );
}

function parseStandShows(pageText) {
  const lines = String(pageText || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => normalizeWs(l))
    .filter(Boolean);

  const shows = [];
  const metaRe =
    /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\s*\|\s*\d{1,2}:\d{2}\s*(AM|PM)\s+/i;

  for (let i = 0; i < lines.length; i++) {
    const title = lines[i];
    if (!title || isNoiseTitle(title) || metaRe.test(title)) continue;

    const metaLine = lines[i + 1];
    const lineupHdr = lines[i + 2];
    if (!metaLine || !lineupHdr) continue;

    const meta = parseMetaLine(metaLine);
    if (!meta) continue;
    if (!/^the lineup$/i.test(lineupHdr)) continue;

    const comedians = [];
    let j = i + 3;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (/^\$\s*\d/.test(l) || /^\$\d/.test(l)) break;
      if (/^the lineup$/i.test(l)) break;
      if (metaRe.test(l)) break;
      if (/^more info$/i.test(l) || /^buy tickets$/i.test(l) || /^sold out$/i.test(l)) break;
      comedians.push({ name: l, credits: "" });
    }

    const priceLine = lines[j];
    if (!priceLine || !/^\$/.test(priceLine)) continue;
    j += 1;

    if (!/^more info$/i.test(lines[j] || "")) continue;
    j += 1;

    const cta = lines[j] || "";
    if (!/^buy tickets$/i.test(cta) && !/^sold out$/i.test(cta)) continue;

    shows.push({
      source: "the-stand",
      date: meta.date,
      time: meta.time,
      venue: meta.venue,
      comedians
    });

    i = j;
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

  await page.waitForFunction(
    () => {
      const t = (document.body?.innerText || "").toLowerCase();
      return (
        t.includes("show") ||
        t.includes("ticket") ||
        t.includes("calendar") ||
        document.querySelectorAll("a, button, [role='button']").length > 8
      );
    },
    { timeout: 120000 }
  );

  await sleep(5000);

  const MORE_SHOWS_WAIT_MS = 2000;
  const MAX_MORE_SHOWS_CLICKS = 100;

  const clickMoreShowsIfPresent = () =>
    page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const moreShowsRe = /\bmore\s+shows\b/i;
      const candidates = Array.from(
        document.querySelectorAll(
          "button, a, div[role='button'], span[role='button'], input[type='button'], input[type='submit']"
        )
      ).filter(isVisible);

      for (const el of candidates) {
        const label = (el.textContent || el.value || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!moreShowsRe.test(label)) continue;
        try {
          if (el instanceof HTMLElement) {
            el.click();
            return true;
          }
        } catch {
          // ignore
        }
      }
      return false;
    });

  for (let n = 0; n < MAX_MORE_SHOWS_CLICKS; n++) {
    const clicked = await clickMoreShowsIfPresent();
    if (!clicked) break;
    await sleep(MORE_SHOWS_WAIT_MS);
  }

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
  const shows = parseStandShows(pageText);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outPath = path.join(__dirname, "stand-lineup.json");
  await fs.writeFile(outPath, JSON.stringify(shows, null, 2), "utf8");
  console.log(`Wrote Stand lineup JSON to: ${outPath}`);

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
