import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://www.gothamcomedyclub.com/calendar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "availability-dump.html");

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
  const html = await res.text();
  fs.writeFileSync(OUT, html, "utf8");
  console.log(`Wrote ${html.length} bytes to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
