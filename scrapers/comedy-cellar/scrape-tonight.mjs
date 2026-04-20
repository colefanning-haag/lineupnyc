import puppeteer from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function parseMoney(text) {
  const m = normalizeWs(text).match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

function parseTimeLabel(text) {
  const t = normalizeWs(text).toLowerCase();
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  return { hh, mm, ap };
}

function formatTime({ hh, mm, ap }) {
  const h = String(hh);
  const m = String(mm).padStart(2, "0");
  return `${h}:${m}${ap}`;
}

function isSameLocalDate(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function parseDateArg(dateArg) {
  // Accepts YYYY-MM-DD as local date.
  const m = normalizeWs(dateArg).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function formatLocalDateYYYYMMDD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

  // Header lines look like:
  // "1:30 pm show - MacDougal Street" or "1:30 pm show-MacDougal Street"
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

    // Heuristic: keep only the first 1–3 name-like tokens.
    // Stop as soon as we hit lowercase words (often credits) or obvious credential keywords.
    const credentialKeywords = new Set([
      "host",
      "hosting",
      "from",
      "writer",
      "writes",
      "wrote",
      "producer",
      "director",
      "actor",
      "actress",
      "star",
      "stars",
      "starring",
      "creator",
      "comic",
      "comedian",
      "regular",
      "cast",
      "featured",
      "featuring",
      "seen",
      "on",
      "in",
      "of",
      "for",
      "at",
      "with"
    ]);

    const isPossessiveCreditsToken = (tok) => /['’]s$/i.test(tok);
    const looksLikeLowercaseWord = (tok) => /^[a-z]/.test(tok);
    const looksLikeNameToken = (tok) => {
      // Allow "J.", "J", "O'Neil", "McDougal", "DJ" etc.
      const stripped = tok.replace(/^[("“”]+|[)"“”,.!?:;]+$/g, "");
      if (!stripped) return false;
      if (/^[A-Z]\.?$/.test(stripped)) return true; // initial
      if (/^[A-Z][a-z]+(?:['’][A-Za-z]+)?$/.test(stripped)) return true; // capitalized word, optional apostrophe part
      // Allow internal capitals like "DiPaolo", "McDonald", "VanDoren"
      if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(stripped)) return true;
      const letters = stripped.replace(/[^A-Za-z]/g, "");
      if (letters.length >= 2 && letters.length <= 4 && letters === letters.toUpperCase()) return true; // short all-caps
      return false;
    };

    let splitIdx = tokens.length;
    const nameTokens = [];

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const lower = tok.toLowerCase();

      // Always accept the first token as part of the name (even if it's imperfect).
      if (i === 0) {
        nameTokens.push(tok);
        continue;
      }

      if (nameTokens.length >= 3) {
        splitIdx = i;
        break;
      }

      // Parenthetical / bracketed qualifiers are almost always credits.
      if (/^[([]/.test(tok)) {
        splitIdx = i;
        break;
      }

      if (looksLikeLowercaseWord(tok)) {
        splitIdx = i;
        break;
      }

      if (credentialKeywords.has(lower) || isPossessiveCreditsToken(tok)) {
        splitIdx = i;
        break;
      }

      if (!looksLikeNameToken(tok)) {
        splitIdx = i;
        break;
      }

      nameTokens.push(tok);
    }

    const name = normalizeWs(nameTokens.join(" "));
    const credits = normalizeWs(tokens.slice(splitIdx).join(" "));
    return { name, credits };
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

    // Each show block ends at "MAKE A RESERVATION"; footer only appears after the last one.
    if (/make a reservation/i.test(line)) {
      collectingComedians = false;
      continue;
    }

    if (!collectingComedians) continue;

    const person = splitNameCredits(line);
    if (!person?.name) continue;

    // Avoid pulling venue/time lines that slipped through.
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
const dateArg = argValue("date"); // YYYY-MM-DD
const parsedDate = dateArg ? parseDateArg(dateArg) : new Date();
const selectedDateStr = dateArg ? dateArg : formatLocalDateYYYYMMDD(parsedDate);
const chromeArg = argValue("chrome"); // optional executable path override

if (dateArg && !parsedDate) {
  console.error("Invalid --date. Expected YYYY-MM-DD");
  process.exit(2);
}

const guessChromeExecutablePath = async () => {
  const candidates = [
    chromeArg,
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim(),
    // macOS default installs
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
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage"
  ]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(url, {
    waitUntil: ["domcontentloaded", "networkidle2"],
    timeout: 120000
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const waitForAnySelector = async (selectors, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) return sel;
        } catch {
          // ignore selector errors and keep trying
        }
      }
      await sleep(250);
    }
    return null;
  };

  // The lineup is rendered client-side. Wait for a likely "show card" / lineup element,
  // then fall back to content-based detection (time + price + at least one name-like line).
  const selectorHit = await waitForAnySelector(
    [
      // common WordPress-ish containers
      ".entry-content",
      "main",
      // lineup-ish hints
      "[class*='lineup' i]",
      "[id*='lineup' i]",
      // reservation widgets sometimes reuse these words
      "[class*='show' i]",
      "[class*='venue' i]"
    ],
    60000
  );

  if (selectorHit) {
    await page.waitForSelector(selectorHit, { timeout: 60000 });
  }

  await page.waitForFunction(
    () => {
      const text = (document.body?.innerText || "").replace(/\u00a0/g, " ");
      const hasTime = /\b\d{1,2}(?::\d{2})?\s*(am|pm)\b/i.test(text);
      const hasMoney = /\$\s*\d+(?:\.\d{1,2})?/.test(text);
      // very rough "comedian-name-ish" signal: 2 capitalized words on a line
      const hasNameLikeLine = text
        .split(/[\r\n]+/)
        .some((l) => /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b/.test(l.trim()));
      return (hasTime && hasMoney) || (hasTime && hasNameLikeLine);
    },
    { timeout: 120000 }
  );

  // Hard wait fallback: give late JS rendering a chance.
  await sleep(5000);

  // Select the requested date (or today's date) in the dropdown before expanding lineups.
  await page.waitForSelector("#cc_lineup_select_dates", { timeout: 60000 });
  await page.evaluate((dateStr) => {
    const sel = document.querySelector("#cc_lineup_select_dates");
    if (!(sel instanceof HTMLSelectElement)) return;
    if (sel.value !== dateStr) {
      sel.value = dateStr;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, selectedDateStr);

  // Give the lineup time to refresh after changing the date.
  await sleep(1500);
  await page.waitForFunction(
    (dateStr) => {
      const sel = document.querySelector("#cc_lineup_select_dates");
      return sel instanceof HTMLSelectElement && sel.value === dateStr;
    },
    { timeout: 60000 },
    selectedDateStr
  );

  // Expand all collapsed lineups. Collapsed headers show "+" and lack `.toggled`.
  await page.evaluate(() => {
    const toggles = Array.from(document.querySelectorAll("span.lineup-toggle:not(.toggled)"));
    for (const t of toggles) {
      if (t instanceof HTMLElement) t.click();
    }
  });

  await sleep(2000);

  const pageText = await page.evaluate(() => document.body?.innerText || "");
  const lineup = parseLineupFromText(pageText, { date: selectedDateStr, source: "comedy-cellar" });
  const outPath = path.join(__dirname, "lineup.json");
  await fs.writeFile(outPath, JSON.stringify(lineup, null, 2), "utf8");
  console.log(`Wrote parsed lineup JSON to: ${outPath}`);
  process.exitCode = 0;
} finally {
  await browser.close();
}

