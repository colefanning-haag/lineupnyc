import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(__dirname, "seed.sql");

function main() {
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

  const db = openDb();
  try {
    db.exec(sql);
    console.log(`Applied seed: ${SEED_FILE}`);
  } finally {
    db.close();
  }
}

main();
