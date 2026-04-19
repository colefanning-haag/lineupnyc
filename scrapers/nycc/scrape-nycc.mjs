import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, saveShows } from "../../db.mjs";

const URL = "https://newyorkcomedyclub.com/calendar";

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

/**
 * Split a comma / "and" / "&" separated blob into individual comedian names.
 */
function splitListToNames(blob) {
  const b = normalizeWs(blob);
  if (!b) return [];
  const names = [];
  for (const chunk of b.split(/\s*,\s*/)) {
    for (const piece of chunk.split(/\s+(?:and|&)\s+/i)) {
      const t = normalizeWs(piece);
      if (t) names.push(t);
    }
  }
  return names;
}

/**
 * NYCC calendar titles often bundle a show name plus headliners, e.g.
 * "Good Eggs ft: Mark Normand, Gary Vider, Matt Ruby".
 * Introducers are checked in priority order (e.g. ft: before w/ so
 * "Matinee w/ Host ft: A, B" yields A, B not the host line only).
 * If nothing matches, the full title is one name. If the title uses
 * " + " as a bill (no introducer), split on + into separate names.
 */
function extractComedianNamesFromTitle(titleLine) {
  const title = normalizeWs(titleLine);
  if (!title) return [];

  const introducers = [
    /\bft\.?:\s*/i,
    /\bfeat\.?:\s*/i,
    /\bpresented\s+by\s+/i,
    /\bfeaturing\s+/i,
    /\bw\/\s*/i,
    /\bwith\s+/i
  ];

  for (const re of introducers) {
    const m = title.match(re);
    if (!m || m.index === undefined) continue;
    const after = normalizeWs(title.slice(m.index + m[0].length));
    if (!after) continue;
    const names = splitListToNames(after);
    if (names.length > 0) return names;
  }

  if (/\s\+\s/.test(title)) {
    const parts = title.split(/\s*\+\s*/).map(normalizeWs).filter(Boolean);
    if (parts.length >= 2) return parts;
  }

  return [title];
}

function toYYYYMMDDFromMonthDay(monthDay, now = new Date()) {
  // monthDay like "May 2nd" / "May 2"
  const m = normalizeWs(monthDay).match(
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?$/i
  );
  if (!m) return null;
  const monthName = m[1].toLowerCase();
  const day = Number(m[2]);
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
  if (month == null) return null;

  // Heuristic year: assume current year, but allow Dec/Jan rollover.
  let year = now.getFullYear();
  const nowMonth = now.getMonth();
  if (nowMonth === 11 && month === 0) year += 1;
  if (nowMonth === 0 && month === 11) year -= 1;

  const dt = new Date(year, month, day);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function parseNyccFromText(pageText, { source }) {
  const lines = String(pageText || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => normalizeWs(l))
    .filter(Boolean);

  const weekdayRe = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  const dateRe =
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?$/i;
  const timeRe = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i; // 10:45PM, 7PM, etc.

  const shows = [];
  let currentDate = null; // YYYY-MM-DD

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (weekdayRe.test(line)) {
      const maybeDate = lines[i + 1];
      if (maybeDate && dateRe.test(maybeDate)) {
        currentDate = toYYYYMMDDFromMonthDay(maybeDate) || currentDate;
        i += 1;
      }
      continue;
    }

    if (dateRe.test(line)) {
      currentDate = toYYYYMMDDFromMonthDay(line) || currentDate;
      continue;
    }

    const tm = line.match(timeRe);
    if (!tm) continue;

    const time = `${tm[1]}:${String(tm[2] ? Number(tm[2]) : 0).padStart(2, "0")} ${tm[3].toLowerCase()}`;

    // Expect: "Show Name at UPPER WEST SIDE"
    const titleLine = lines[i + 1] || "";
    const atIdx = titleLine.toLowerCase().lastIndexOf(" at ");
    if (atIdx === -1) continue;

    const rawTitle = normalizeWs(titleLine.slice(0, atIdx));
    const venue = normalizeWs(titleLine.slice(atIdx + 4));
    if (!rawTitle || !venue) continue;

    // Description: lines after title until BUY TICKETS (or next time/date/day)
    const descParts = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (/^buy tickets$/i.test(l)) break;
      if (weekdayRe.test(l) || dateRe.test(l) || timeRe.test(l)) break;
      descParts.push(l);
    }
    const credits = normalizeWs(descParts.join(" "));

    const nameParts = extractComedianNamesFromTitle(rawTitle);
    const comedians = nameParts.map((n, idx) => ({
      name: n,
      credits: idx === 0 ? credits : ""
    }));

    shows.push({
      source,
      date: currentDate || "",
      time,
      venue,
      comedians
    });

    i = j;
  }

  // Drop any shows without a date (should be rare; indicates we missed the date header)
  return shows.filter((s) => s.date);
}

const headful = hasFlag("headful");
const chromeArg = argValue("chrome"); // optional executable path override

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

  // Wait for the page to render something calendar-ish.
  await page.waitForFunction(
    () => {
      const t = (document.body?.innerText || "").toLowerCase();
      return (
        t.includes("calendar") ||
        t.includes("show") ||
        t.includes("tickets") ||
        document.querySelectorAll("a, button, [role='button']").length > 10
      );
    },
    { timeout: 120000 }
  );

  // Hard wait fallback.
  await sleep(5000);

  // Best-effort expand of collapsible sections:
  // - click [aria-expanded="false"]
  // - click obvious "more" / "+" / "expand" buttons
  // - click any visible buttons with short labels (common toggles)
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
  const shows = parseNyccFromText(pageText, { source: "nycc" });

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outPath = path.join(__dirname, "nycc-lineup.json");
  await fs.writeFile(outPath, JSON.stringify(shows, null, 2), "utf8");
  console.log(`Wrote NYCC lineup JSON to: ${outPath}`);

  const db = openDb();
  try {
    const del = db.prepare(`DELETE FROM shows WHERE source = ?`);
    const removed = del.run("nycc").changes;
    console.log(`Removed existing NYCC rows from spotlight.db: ${removed}`);
    const { inserted, skipped } = saveShows(db, shows);
    console.log(`Saved to spotlight.db: inserted ${inserted}, skipped ${skipped}`);
  } finally {
    db.close();
  }
} finally {
  await browser.close();
}

