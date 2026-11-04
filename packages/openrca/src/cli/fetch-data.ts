/**
 * `pnpm --filter @evorca/openrca fetch-data [system...]` fetches `query.csv`
 * and `record.csv` of the named systems, or of all four, into `data/openrca/`.
 *
 * It prints one line per file and exits with code 1 if a name is not an
 * OpenRCA system.
 *
 * @module
 */
import { fetchOpenRcaData } from "../dataset/fetch.js";
import { openRcaSystems, type OpenRcaSystem } from "../tasks.js";
import { dataDir } from "./paths.js";

const isSystem = (name: string): name is OpenRcaSystem =>
  openRcaSystems.some((system) => system === name);

const requested = process.argv.slice(2);
if (!requested.every(isSystem)) {
  const unknown = requested.filter((name) => !isSystem(name));
  console.error(
    `Unknown systems: ${unknown.join(", ")}. Choose from: ${openRcaSystems.join(", ")}`,
  );
  process.exit(1);
}

const systems = requested.length > 0 ? requested : openRcaSystems;
for (const file of await fetchOpenRcaData({ systems, dataDir })) {
  const status = file.fetched ? "fetched" : "present";
  console.log(`${status}  ${file.file}  ${file.bytes} bytes  sha256 ${file.sha256}`);
}
