/**
 * Downloads OpenRCA's answer keys, `query.csv` and `record.csv`, from the
 * published dataset archives.
 *
 * The archives hold about 8.8 GB, almost all of it telemetry. fetchOpenRcaData
 * downloads only the two small files of each system and checks each against
 * its pinned SHA-256 before it writes the file. It checks and keeps a file that
 * is already on disk, so a second run downloads nothing.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  archiveOf,
  dataFileSha256,
  driveArchives,
  type Archive,
  type DataFile,
} from "../pinned.js";
import type { OpenRcaSystem } from "../tasks.js";
import { readRemoteZipEntry } from "./remote-zip.js";

type FetchedFile = {
  readonly file: DataFile;
  readonly bytes: number;
  readonly sha256: string;
  readonly fetched: boolean;
};

/**
 * Makes sure that `query.csv` and `record.csv` of each system are in `dataDir`
 * and match their pinned hashes.
 *
 * It writes each file to a temporary name and then renames it, so an
 * interrupted run never leaves a partial file under the final name.
 *
 * @param systems - The systems to fetch.
 * @param dataDir - The directory to write `<system>/query.csv` and
 *   `<system>/record.csv` to.
 * @param archives - The archive that holds the files, by archive name.
 *   Defaults to the published archives.
 * @param sha256 - The SHA-256 that each file must have. Defaults to the pinned
 *   hashes.
 * @returns One entry per file, in the order of `systems`, with `query.csv`
 *   before `record.csv`. `fetched` is false for a file that was already on disk.
 * @throws Error if a file on disk or a downloaded file does not match its hash,
 *   or if a download fails.
 */
export async function fetchOpenRcaData(
  systems: readonly OpenRcaSystem[],
  dataDir: string,
  archives: Readonly<Record<keyof typeof driveArchives, Archive>> = driveArchives,
  sha256: Readonly<Record<DataFile, string>> = dataFileSha256,
): Promise<FetchedFile[]> {
  const fetched: FetchedFile[] = [];
  for (const system of systems) {
    const archive = archives[archiveOf[system]];
    for (const file of [`${system}/query.csv`, `${system}/record.csv`] as const) {
      fetched.push(await ensureFile(archive, file, sha256[file], dataDir));
    }
  }
  return fetched;
}

async function ensureFile(
  archive: Archive,
  file: DataFile,
  sha256: string,
  dataDir: string,
): Promise<FetchedFile> {
  const path = join(dataDir, file);
  const local = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (local !== undefined) {
    return {
      ...verify(file, local, sha256, `${path} is not the published file; delete it`),
      fetched: false,
    };
  }
  const bytes = await readRemoteZipEntry(archive.url, archive.bytes, file);
  const verified = verify(file, bytes, sha256, "the download is not the published file");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, bytes);
  await rename(`${path}.tmp`, path);
  return { ...verified, fetched: true };
}

function verify(file: DataFile, bytes: Buffer, expected: string, problem: string) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`${file}: ${problem} (sha256 ${actual}, expected ${expected})`);
  }
  return { file, bytes: bytes.length, sha256: actual };
}
