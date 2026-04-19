import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDatabasePath() {
  const fromEnv = process.env.DB_PATH?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.resolve(process.cwd(), "spotlight.db");
}

const DB_PATH = resolveDatabasePath();

export function getDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  return db;
}

export function initDb(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      venue TEXT NOT NULL,
      comedian_names TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS shows_uniq
      ON shows(source, date, time, venue);

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      comedian TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_notified TEXT
    );
  `);

  const wlCols = db.prepare(`PRAGMA table_info(watchlist)`).all();
  if (!wlCols.some((c) => c.name === "last_notified")) {
    db.exec(`ALTER TABLE watchlist ADD COLUMN last_notified TEXT`);
  }
}

export function openDb() {
  const db = getDb();
  initDb(db);
  return db;
}

function normalizeWs(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comedianNames(show) {
  const names = (show?.comedians || [])
    .map((c) => normalizeWs(c?.name))
    .filter(Boolean);
  return names.join(", ");
}

export function saveShows(db, shows) {
  if (!Array.isArray(shows)) throw new Error("saveShows expects an array");

  const insert = db.prepare(`
    INSERT OR IGNORE INTO shows
      (source, date, time, venue, comedian_names, raw_json)
    VALUES
      (@source, @date, @time, @venue, @comedian_names, @raw_json)
  `);

  const tx = db.transaction((rows) => {
    let inserted = 0;
    let skipped = 0;
    for (const show of rows) {
      const source = normalizeWs(show?.source);
      const date = normalizeWs(show?.date);
      const time = normalizeWs(show?.time);
      const venue = normalizeWs(show?.venue);

      if (!source || !date || !time || !venue) continue;

      const info = insert.run({
        source,
        date,
        time,
        venue,
        comedian_names: comedianNames(show),
        raw_json: JSON.stringify(show)
      });

      if (info.changes > 0) inserted += 1;
      else skipped += 1;
    }
    return { inserted, skipped };
  });

  return tx(shows);
}

