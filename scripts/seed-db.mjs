import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(__dirname, "seed.sql");

const force = process.argv.includes("--force");

function main() {
  const db = openDb();
  try {
    let existing = 0;
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM shows`).get();
      existing = Number(row?.c ?? 0);
    } catch {
      // `shows` missing (should not happen after initDb); treat as empty.
      existing = 0;
    }

    if (!force && existing > 0) {
      console.log(
        `Skipping seed: shows already has ${existing} row(s). Database left unchanged.`
      );
      return;
    }

    if (force && existing > 0) {
      console.log(
        `Force seed: applying ${SEED_FILE} (drops and recreates shows only; watchlist unchanged).`
      );
    }

    if (!fs.existsSync(SEED_FILE)) {
      console.error(`Missing seed file: ${SEED_FILE}`);
      console.error("Run: npm run export:db");
      process.exit(1);
    }

    const sql = fs.readFileSync(SEED_FILE, "utf8").trim();
    if (!sql) {
      console.error(`Seed file is empty: ${SEED_FILE}`);
      process.exit(1);
    }

    db.exec(sql);
    console.log(`Applied seed: ${SEED_FILE}`);
  } finally {
    db.close();
  }
}

main();
