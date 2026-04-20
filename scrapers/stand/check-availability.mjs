import { openDb } from "../../db.mjs";

const URL = "https://thestandnyc.com/shows";
const SOURCE = "the-stand";

function normalizeWs(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTime12h(hh24, mm) {
  const ap = hh24 >= 12 ? "pm" : "am";
  let h = hh24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ap}`;
}

/** Parse `/shows/show/12846/2026-04-19-190000-slug` → { date, time } */
function parseShowSlugFromHtml(html) {
  const re =
    /\/shows\/show\/\d+\/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})[^"'#\s]*/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    let hh = Number(m[4]);
    const mm = Number(m[5]);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day) ||
      !Number.isFinite(hh) ||
      !Number.isFinite(mm)
    ) {
      continue;
    }
    const d = new Date(year, month - 1, day);
    if (
      d.getFullYear() !== year ||
      d.getMonth() !== month - 1 ||
      d.getDate() !== day
    ) {
      continue;
    }
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const time = formatTime12h(hh, mm);
    return { date, time };
  }
  return null;
}

function parseVenueFromChunk(html) {
  const mRoom =
    html.match(/<span class="list-show-room[^"]*">([^<]*)<\/span>/i) ||
    html.match(/class="[^"]*list-show-room-new[^"]*"[^>]*>([^<]+)</i);
  const raw = mRoom ? normalizeWs(mRoom[1]) : "";
  const upper = raw.toUpperCase();
  if (upper.includes("UPSTAIRS")) return "The Stand - Upstairs";
  if (upper.includes("MAIN")) return "The Stand - Main Room";
  return "";
}

function stripHtmlComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * @returns {'SOLD OUT' | 'BUY TICKETS' | 'GET TICKETS' | null}
 */
function parseAvailabilityFromChunk(html) {
  if (/class="btn btn-outline-danger"[^>]*>\s*Sold\s*Out\s*</i.test(html)) {
    return "SOLD OUT";
  }
  if (
    /<a[^>]*\bbtn-stand\b[^>]*>[\s\S]*?Get[\s\S]*?Tickets[\s\S]*?<\/a>/i.test(
      html
    )
  ) {
    return "GET TICKETS";
  }
  if (
    /<a[^>]*\bbtn-stand\b[^>]*>[\s\S]*?Buy[\s\S]*?Tickets[\s\S]*?<\/a>/i.test(
      html
    )
  ) {
    return "BUY TICKETS";
  }
  return null;
}

function splitShowRowChunks(html) {
  const re = /<div class="row show_row[^>]*>/gi;
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
        "Mozilla/5.0 (compatible; LineupNYC/1.0; +https://github.com/) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml"
    }
  });
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const html = await res.text();

  const rawChunks = splitShowRowChunks(html);
  const parsed = [];
  for (const raw of rawChunks) {
    const chunk = stripHtmlComments(raw);
    const slug = parseShowSlugFromHtml(chunk);
    const venue = parseVenueFromChunk(chunk);
    const availability = parseAvailabilityFromChunk(chunk);
    if (!slug || !venue || !availability) continue;
    parsed.push({ ...slug, venue, availability });
  }

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
    `Stand availability: parsed ${parsed.length} show(s) from first HTML page; ` +
      `updated ${updated} row(s) in DB; ${noMatch} parsed slot(s) had no matching the-stand row.`
  );
  if (rawChunks.length && parsed.length === 0) {
    console.warn(
      "No shows parsed (page structure may have changed). Check selectors."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
