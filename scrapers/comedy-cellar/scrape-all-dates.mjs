import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import { openDb, saveShows } from "../../db.mjs";

const DEFAULT_URL = "https://www.comedycellar.com/new-york-line-up/";

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

function parseLineupFromText(pageText, { date, source }) {
  const lines = String(pageText || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => normalizeWs(l))
    .filter(Boolean);

  const shows = [];
  let current = null;
  let collectingComedians = false;

  const headerRe = /^(\d{1,2}:\d{2})\s*(am|pm)\s*show\s*[-–]\s*(.+)$/i;

  const shouldIgnoreLine = (line) => {
    const l = line.toLowerCase();
    return (
      l === "+" ||
      l === "-" ||
      l.startsWith("choose a day") ||
      l.startsWith("showtimes") ||
      l.startsWith("wrote page") ||
      l === "> website" ||
      l === "website" ||
      l.startsWith("http://") ||
      l.startsWith("https://") ||
      l.startsWith("www.")
    );
  };

  const splitNameCredits = (line) => {
    const tokens = normalizeWs(line).split(" ").filter(Boolean);
    if (!tokens.length) return null;

    const upperTokenIdx = tokens.findIndex((tok, idx) => {
      if (idx === 0) return false;
      const letters = tok.replace(/[^A-Za-z]/g, "");
      return letters.length >= 2 && letters === letters.toUpperCase();
    });

    let name = "";
    let credits = "";

    if (upperTokenIdx !== -1) {
      name = tokens.slice(0, upperTokenIdx).join(" ");
      credits = tokens.slice(upperTokenIdx).join(" ");
    } else if (tokens.length >= 3) {
      name = tokens.slice(0, 2).join(" ");
      credits = tokens.slice(2).join(" ");
    } else {
      name = tokens.join(" ");
      credits = "";
    }

    return { name: normalizeWs(name), credits: normalizeWs(credits) };
  };

  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      current = {
        source,
        date,
        time: `${m[1]} ${m[2].toLowerCase()}`,
        venue: normalizeWs(m[3]),
        comedians: []
      };
      shows.push(current);
      collectingComedians = true;
      continue;
    }

    if (!current) continue;
    if (shouldIgnoreLine(line)) continue;

    if (/make a reservation/i.test(line)) {
      collectingComedians = false;
      continue;
    }
    if (!collectingComedians) continue;

    const person = splitNameCredits(line);
    if (!person?.name) continue;
    if (headerRe.test(line)) continue;

    current.comedians.push(person);
  }

  // De-dupe comedians per show (name+credits).
  for (const s of shows) {
    const seen = new Set();
    s.comedians = s.comedians.filter((c) => {
      const key = `${c.name}__${c.credits}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  return shows;
}

const url = argValue("url") || DEFAULT_URL;
const headful = hasFlag("headful");
const chromeArg = argValue("chrome");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromePath = await guessChromeExecutablePath();

const db = openDb();
const browser = await puppeteer.launch({
  headless: headful ? false : "new",
  ...(chromePath ? { executablePath: chromePath } : {}),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 120000 });

  await page.waitForSelector("#cc_lineup_select_dates", { timeout: 60000 });

  const availableDates = await page.evaluate(() => {
    const sel = document.querySelector("#cc_lineup_select_dates");
    if (!(sel instanceof HTMLSelectElement)) return [];
    return Array.from(sel.options).map((o) => o.value).filter(Boolean);
  });

  for (const dateStr of availableDates) {
    console.log(`Scraping ${dateStr}...`);

    await page.evaluate((d) => {
      const sel = document.querySelector("#cc_lineup_select_dates");
      if (!(sel instanceof HTMLSelectElement)) return;
      sel.value = d;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, dateStr);

    await sleep(1500);

    // Expand all collapsed lineups for this date.
    await page.evaluate(() => {
      const toggles = Array.from(document.querySelectorAll("span.lineup-toggle:not(.toggled)"));
      for (const t of toggles) if (t instanceof HTMLElement) t.click();
    });

    await sleep(2000);

    const pageText = await page.evaluate(() => document.body?.innerText || "");
    const shows = parseLineupFromText(pageText, { date: dateStr, source: "comedy-cellar" });
    const { inserted, skipped } = saveShows(db, shows);

    console.log(`Scraping ${dateStr}... saved ${inserted} shows (skipped ${skipped})`);
    await sleep(2000);
  }
} finally {
  await browser.close();
  db.close();
}

