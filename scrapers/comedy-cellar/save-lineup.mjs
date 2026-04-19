import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, saveShows } from "../../db.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LINEUP_PATH = path.join(__dirname, "lineup.json");

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

const raw = await fs.readFile(LINEUP_PATH, "utf8");
const lineup = JSON.parse(raw);

if (!Array.isArray(lineup)) {
  throw new Error("lineup.json must be an array of show objects");
}

const db = openDb();
try {
  const { inserted, skipped } = saveShows(db, lineup);
  console.log(`Inserted: ${inserted}, skipped (duplicates): ${skipped}`);
} finally {
  db.close();
}

