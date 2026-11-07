// Imported first by server/vercel.ts, before any module that touches the disk.
// On Vercel only /tmp is writable: caches go there (they rebuild on a cold start),
// and personal data belongs in Postgres via DATABASE_URL.
import { dirname } from "path";
import { fileURLToPath } from "url";

process.env.DATA_DIR ??= "/tmp/meridian";

// The bundled datasets (cities, airports, seasonality) sit in data/ next to this
// bundle, and the server reads them relative to the working directory.
process.chdir(dirname(fileURLToPath(import.meta.url)));
