/**
 * `pnpm --filter @evorca/openrca pin-telemetry` writes the size and SHA-256 of
 * each telemetry file in the published dataset archives to
 * `src/pinned-telemetry.json`. A telemetry file is an archive entry
 * `<System>/telemetry/<YYYY_MM_DD>/<log|metric|trace>/<file>` whose name does
 * not start with a dot, which leaves out the `.DS_Store` files in the archives.
 * The script streams each telemetry file through SHA-256 once and writes
 * nothing else to disk.
 *
 * @module
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { measure } from "../dataset/fetch.js";
import { openRemoteZip } from "../dataset/remote-zip.js";
import { driveArchives, type FileDigest } from "../pinned.js";
import { openRcaScenarios } from "../scenarios.js";

const outPath = fileURLToPath(new URL("../pinned-telemetry.json", import.meta.url));
const systems = Object.values(openRcaScenarios).join("|");
const telemetryFile = new RegExp(
  `^(?:${systems})/telemetry/\\d{4}_\\d{2}_\\d{2}/(?:log|metric|trace)/[^./][^/]*$`,
);

const pinned = await Promise.all(
  Object.values(driveArchives).map(async (archive) => {
    const zip = await openRemoteZip(archive.url, archive.bytes);
    const files: [string, FileDigest][] = [];
    for (const fileName of zip.fileNames.filter((name) => telemetryFile.test(name))) {
      const file = await measure(await zip.open(fileName));
      console.log(`${file.sha256}  ${String(file.bytes).padStart(10)}  ${fileName}`);
      files.push([fileName, file]);
    }
    return files;
  }),
);
const files = pinned.flat().sort(([a], [b]) => (a < b ? -1 : 1));
await writeFile(outPath, `${JSON.stringify(Object.fromEntries(files), null, 2)}\n`);
const bytes = files.reduce((total, [, file]) => total + file.bytes, 0);
console.log(`Pinned ${files.length} files, ${bytes} bytes, in ${outPath}`);
