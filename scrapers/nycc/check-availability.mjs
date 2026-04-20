import { openDb } from "../../db.mjs";

const URL = "https://newyorkcomedyclub.com/calendar";
const SOURCE = "nycc";

function normalizeWs(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtmlTags(s) {
  return String(s).replace(/<[^>]+>/g, " ");
}

function stripHtmlComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, "");
}

/** Same calendar month/day → YYYY-MM-DD heuristic as `scrape-nycc.mjs`. */
function toYYYYMMDDFromMonthDay(monthDay, now = new Date()) {
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

  let year = now.getFullYear();
  const nowMonth = now.getMonth();
  if (nowMonth === 11 && month === 0) year += 1;
  if (nowMonth === 0 && month === 11) year -= 1;

  const dt = new Date(year, month, day);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Match `scrape-nycc.mjs` `parseNyccFromText` time formatting. */
function parseTimeForDb(timeStr) {
  const t = normalizeWs(timeStr);
  const tm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!tm) return null;
  return `${tm[1]}:${String(tm[2] ? Number(tm[2]) : 0).padStart(2, "0")} ${tm[3].toLowerCase()}`;
}

function venueFromChunk(html) {
  const m = html.match(/class="[^"]*scheduled-venue[^"]*"[^>]*>([^<]+)</i);
  if (!m) return "";
  return normalizeWs(m[1]).toUpperCase();
}

function parseDateTimeFromChunk(html) {
  const ul = html.match(
    /<ul class="list-unstyled text-center event-date-ul">([\s\S]*?)<\/ul>/i
  );
  if (ul) {
    const lis = [...ul[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) =>
      normalizeWs(stripHtmlTags(x[1]))
    );
    if (lis.length >= 3) {
      const date = toYYYYMMDDFromMonthDay(lis[1]);
      const time = parseTimeForDb(lis[2]);
      if (date && time) return { date, time };
    }
  }

  const aria = html.match(
    /aria-label="[A-Za-z]+\s+([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?)\s+(\d{1,2}:\d{2}\s*(?:AM|PM)|\d{1,2}:\d{2}(?:AM|PM))"/i
  );
  if (aria) {
    const date = toYYYYMMDDFromMonthDay(aria[1]);
    const time = parseTimeForDb(aria[2]);
    if (date && time) return { date, time };
  }

  return null;
}

function parseCtaAvailability(html) {
  const matches = [
    ...html.matchAll(/<a class="btn btn-default"[\s\S]*?<\/a>/gi)
  ];
  for (const m of matches) {
    const text = normalizeWs(stripHtmlTags(m[0]));
    if (/^buy tickets$/i.test(text)) return "BUY TICKETS";
    if (/^join waitlist$/i.test(text)) return "SOLD OUT";
  }
  return null;
}

function splitUpcomingRowChunks(html) {
  const re = /<div class="row upcoming-container-list[^"]*">/gi;
  const starts = [];
  let mm;
  while ((mm = re.exec(html)) !== null) {
    starts.push({ openEnd: mm.index + mm[0].length, fullStart: mm.index });
  }
  const chunks = [];
  for (let i = 0; i < starts.length; i++) {
    const openEnd = starts[i].openEnd;
    const nextStart =
      i + 1 < starts.length ? starts[i + 1].fullStart : html.length;
    chunks.push(html.slice(openEnd, nextStart));
  }
  return chunks;
}

async function main() {
  const res = await fetch(URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; LineupNYC/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml"
    }
  });
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const html = stripHtmlComments(await res.text());

  const rawChunks = splitUpcomingRowChunks(html);
  const byKey = new Map();
  for (const raw of rawChunks) {
    const dt = parseDateTimeFromChunk(raw);
    const venue = venueFromChunk(raw);
    const availability = parseCtaAvailability(raw);
    if (!dt || !venue || !availability) continue;
    const key = `${dt.date}|${dt.time}|${venue}`;
    byKey.set(key, {
      date: dt.date,
      time: dt.time,
      venue,
      availability
    });
  }
  const parsed = [...byKey.values()];

  const db = openDb();
  const update = db.prepare(`
    UPDATE shows
    SET availability = @availability
    WHERE source = @source
      AND date = @date
      AND time = @time
      AND venue = @venue
  `);

  let updated = 0;
  let noMatch = 0;
  try {
    const tx = db.transaction((rows) => {
      for (const row of rows) {
        const info = update.run({
          source: SOURCE,
          date: row.date,
          time: row.time,
          venue: row.venue,
          availability: row.availability
        });
        if (info.changes > 0) updated += 1;
        else noMatch += 1;
      }
    });
    tx(parsed);
  } finally {
    db.close();
  }

  console.log(
    `NYCC availability: parsed ${parsed.length} listing(s); ` +
      `updated ${updated} row(s) in DB; ${noMatch} listing(s) had no matching nycc row.`
  );
  if (rawChunks.length && parsed.length === 0) {
    console.warn(
      "No listings parsed (page structure may have changed). Check selectors."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
