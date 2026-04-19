import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Resend } from "resend";
import { openDb } from "../db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env"), quiet: true });

const FROM = "onboarding@resend.dev";

const TICKET_URLS = {
  "comedy-cellar": "https://www.comedycellar.com/reservations",
  nycc: "https://newyorkcomedyclub.com/calendar",
  gotham: "https://www.gothamcomedyclub.com/calendar",
  "the-stand": "https://thestandnyc.com/shows"
};

function ticketUrlForSource(source) {
  const s = String(source || "").trim();
  return TICKET_URLS[s] || TICKET_URLS["comedy-cellar"];
}

function todayISOInLocalTimezone() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysToISO(iso, deltaDays) {
  const [y, mo, da] = String(iso)
    .trim()
    .split("-")
    .map((n) => Number(n));
  const dt = new Date(y, mo - 1, da);
  dt.setDate(dt.getDate() + deltaDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(comedian, shows) {
  const linkStyle =
    "color:#1d4ed8;text-decoration:none;font-weight:600;white-space:nowrap";
  const rows = shows
    .map((s) => {
      const href = escapeHtml(ticketUrlForSource(s.source));
      const link = `<a href="${href}" target="_blank" rel="noopener noreferrer" style="${linkStyle}">Get Tickets →</a>`;
      return (
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee">${escapeHtml(s.date)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee">${escapeHtml(s.time)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee">${escapeHtml(s.venue)}</td>` +
        `<td style="padding:8px 12px;border-bottom:1px solid #eee">${link}</td></tr>`
      );
    })
    .join("");

  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>Hi — we found upcoming shows for <strong>${escapeHtml(comedian)}</strong> in the next week:</p>
<table style="border-collapse:collapse;width:100%;max-width:560px">
<thead><tr>
<th align="left" style="padding:8px 12px;border-bottom:2px solid #ccc">Date</th>
<th align="left" style="padding:8px 12px;border-bottom:2px solid #ccc">Time</th>
<th align="left" style="padding:8px 12px;border-bottom:2px solid #ccc">Venue</th>
<th align="left" style="padding:8px 12px;border-bottom:2px solid #ccc">Tickets</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
<p style="font-size:14px;color:#666">You’re receiving this because you signed up for Spotlight alerts.</p>
</body></html>`;
}

function maxShowDate(shows) {
  return shows.reduce((m, s) => (String(s.date) > m ? String(s.date) : m), String(shows[0].date));
}

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    console.error("Missing RESEND_API_KEY in .env");
    process.exit(1);
  }

  const resend = new Resend(apiKey);
  const db = openDb();

  const today = todayISOInLocalTimezone();
  const weekEnd = addDaysToISO(today, 6);

  const listWatch = db.prepare(
    `SELECT id, email, comedian, last_notified FROM watchlist ORDER BY id ASC`
  );
  const fetchShows = db.prepare(`
    SELECT date, time, venue, comedian_names, source
    FROM shows
    WHERE date >= ? AND date <= ?
      AND instr(lower(comedian_names), lower(?)) > 0
    ORDER BY date ASC, time ASC
  `);
  const updateLast = db.prepare(
    `UPDATE watchlist SET last_notified = ? WHERE id = ?`
  );

  try {
    const entries = listWatch.all();
    if (!entries.length) {
      console.log("No watchlist entries.");
      return;
    }

    let sent = 0;
    let skipped = 0;

    for (const row of entries) {
      const email = String(row.email || "").trim();
      const comedian = String(row.comedian || "").trim();
      if (!email || !comedian) {
        skipped += 1;
        continue;
      }

      const allMatches = fetchShows.all(today, weekEnd, comedian);
      const last = row.last_notified != null ? String(row.last_notified).trim() : "";
      const fresh = allMatches.filter((s) => !last || String(s.date) > last);

      if (!fresh.length) {
        skipped += 1;
        continue;
      }

      const { data, error } = await resend.emails.send({
        from: FROM,
        to: email,
        subject: `Spotlight: upcoming shows for ${comedian}`,
        html: buildEmailHtml(comedian, fresh)
      });

      if (error) {
        console.error(`Resend error for watchlist id=${row.id} (${email}):`, error);
        continue;
      }

      const nextLast = maxShowDate(fresh);
      updateLast.run(nextLast, row.id);
      sent += 1;
      console.log(`Sent alert id=${row.id} to ${email} (${fresh.length} show(s)), last_notified=${nextLast}`, data?.id ?? "");
    }

    console.log(`Done. Sent: ${sent}, skipped (no new shows or bad row): ${skipped}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
