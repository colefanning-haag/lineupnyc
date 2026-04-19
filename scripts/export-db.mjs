import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, "seed.sql");

/** Tables to export, in dependency-safe order (CREATE / INSERT). */
const TABLES = ["shows", "watchlist"];

function sqlLiteral(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "bigint") return String(val);
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return "NULL";
    return String(val);
  }
  return `'${String(val).replace(/'/g, "''")}'`;
}

function main() {
  const db = openDb();
  const lines = [];

  lines.push("-- Exported by scripts/export-db.mjs");
  lines.push(`-- ${new Date().toISOString()}`);
  lines.push("PRAGMA foreign_keys=OFF;");
  lines.push("BEGIN TRANSACTION;");
  lines.push("");

  for (const t of TABLES) {
    lines.push(`DROP TABLE IF EXISTS ${t};`);
  }
  lines.push("");

  for (const t of TABLES) {
    const row = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
      )
      .get(t);
    if (row?.sql) {
      lines.push(row.sql + ";");
      lines.push("");
    }
  }

  const indexes = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name IN ('shows', 'watchlist') AND sql IS NOT NULL
       ORDER BY name`
    )
    .all();
  for (const { sql } of indexes) {
    if (sql) lines.push(sql + ";");
  }
  if (indexes.length) lines.push("");

  for (const t of TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.length) continue;

    const colList = cols.map((c) => `"${c}"`).join(", ");
    const rows = db.prepare(`SELECT ${colList} FROM "${t}"`).all();

    lines.push(`-- ${t} (${rows.length} rows)`);
    for (const row of rows) {
      const vals = cols.map((c) => sqlLiteral(row[c]));
      lines.push(
        `INSERT INTO "${t}" (${colList}) VALUES (${vals.join(", ")});`
      );
    }
    lines.push("");
  }

  const hasSeq = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`
    )
    .get();
  if (hasSeq) {
    const seqRows = db
      .prepare(
        `SELECT name, seq FROM sqlite_sequence WHERE name IN ('shows', 'watchlist')`
      )
      .all();
    if (seqRows.length) {
      lines.push("-- preserve AUTOINCREMENT");
      lines.push(
        `DELETE FROM sqlite_sequence WHERE name IN ('shows', 'watchlist');`
      );
      for (const r of seqRows) {
        lines.push(
          `INSERT INTO sqlite_sequence (name, seq) VALUES (${sqlLiteral(r.name)}, ${sqlLiteral(r.seq)});`
        );
      }
      lines.push("");
    }
  }

  lines.push("COMMIT;");

  fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
  db.close();
  console.log(`Wrote ${OUT_FILE}`);
}

main();
