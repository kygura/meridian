// Copy Meridian's personal data from JSON files into Postgres, for moving off a
// host with a persistent disk (e.g. Render) to one configured with DATABASE_URL.
//
// Usage:
//   DATA_DIR=/path/to/data DATABASE_URL=postgres://… npx tsx scripts/copy-data-to-postgres.ts [--overwrite]
//
// Existing database rows are kept unless --overwrite is given. Caches are skipped;
// the app rebuilds them.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { closeDatabase, databaseUrl, pgRead, pgWrite } from "../server/lib/pgDocuments.ts";

const DOCUMENTS = [
  "journal.json",
  "settings.json",
  "imports.json",
  "watches.json",
  "alerts.json",
  "bookings.json",
  "shortlist.json",
  "trips.json",
];

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
const overwrite = process.argv.includes("--overwrite");

if (!databaseUrl()) {
  console.error("Set DATABASE_URL to the target database.");
  process.exit(1);
}

let failed = false;
for (const key of DOCUMENTS) {
  const file = join(dataDir, key);
  if (!existsSync(file)) {
    console.log(`skip  ${key} (no file)`);
    continue;
  }
  try {
    const value = JSON.parse(readFileSync(file, "utf-8"));
    const missing = Symbol("missing");
    const existing = await pgRead<unknown>(key, () => missing);
    if (existing !== missing && !overwrite) {
      console.log(`keep  ${key} (already in the database; --overwrite to replace)`);
      continue;
    }
    await pgWrite(key, value);
    console.log(`copy  ${key}`);
  } catch (err) {
    failed = true;
    console.error(`fail  ${key}: ${(err as Error).message}`);
  }
}
await closeDatabase();
process.exit(failed ? 1 : 0);
