import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db.mjs";

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.use(express.json());
const db = openDb();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function todayISOInServerLocalTimezone() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

app.get("/shows", (req, res) => {
  try {
    const date = req.query.date;
    const dateFrom = req.query.date_from;
    const dateTo = req.query.date_to;
    const comedian = req.query.comedian;

    let sql = `
      SELECT id, source, date, time, venue, comedian_names, raw_json, created_at
      FROM shows
      WHERE 1 = 1
    `;
    const params = [];

    const fromStr = dateFrom != null ? String(dateFrom).trim() : "";
    const toStr = dateTo != null ? String(dateTo).trim() : "";
    const dateStr = date != null ? String(date).trim() : "";

    if (fromStr !== "" && toStr !== "") {
      let df = fromStr;
      let dt = toStr;
      if (df > dt) [df, dt] = [dt, df];
      sql += " AND date >= ? AND date <= ?";
      params.push(df, dt);
    } else if (dateStr !== "") {
      sql += " AND date = ?";
      params.push(dateStr);
    } else {
      sql += " AND date >= ?";
      params.push(todayISOInServerLocalTimezone());
    }

    if (comedian != null && String(comedian).trim() !== "") {
      sql += " AND instr(lower(comedian_names), lower(?)) > 0";
      params.push(String(comedian).trim());
    }

    sql += " ORDER BY date ASC, time ASC";

    const limitRaw = req.query.limit;
    if (limitRaw != null && String(limitRaw).trim() !== "") {
      const lim = parseInt(String(limitRaw).trim(), 10);
      if (Number.isFinite(lim) && lim > 0) {
        const capped = Math.min(lim, 500);
        let off = 0;
        const offsetRaw = req.query.offset;
        if (offsetRaw != null && String(offsetRaw).trim() !== "") {
          const o = parseInt(String(offsetRaw).trim(), 10);
          if (Number.isFinite(o) && o >= 0) off = o;
        }
        sql += " LIMIT ? OFFSET ?";
        params.push(capped, off);
      }
    }

    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load shows" });
  }
});

app.get("/comedians", (req, res) => {
  try {
    const qRaw = req.query.q != null ? String(req.query.q).trim() : "";
    const rows = db
      .prepare(
        `
        SELECT comedian_names
        FROM shows
        WHERE comedian_names IS NOT NULL AND trim(comedian_names) != ''
      `
      )
      .all();

    const uniq = new Set();
    for (const row of rows) {
      for (const part of String(row.comedian_names).split(",")) {
        const name = part.trim();
        if (name) uniq.add(name);
      }
    }

    let names = [...uniq].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    if (qRaw === "") {
      res.json([]);
      return;
    }

    const ql = qRaw.toLowerCase();
    names = names.filter((n) => n.toLowerCase().includes(ql));

    res.json(names);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load comedians" });
  }
});

app.post("/watchlist", (req, res) => {
  try {
    const email =
      req.body?.email != null ? String(req.body.email).trim() : "";
    const comedian =
      req.body?.comedian != null ? String(req.body.comedian).trim() : "";
    if (!email || !comedian) {
      return res
        .status(400)
        .json({ success: false, error: "email and comedian are required" });
    }
    db.prepare(
      `INSERT INTO watchlist (email, comedian) VALUES (?, ?)`
    ).run(email, comedian);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to save watchlist" });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const server = app.listen(PORT, () => {
  console.log(`spotlight api listening on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
