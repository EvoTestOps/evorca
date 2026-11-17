/**
 * Downloads OpenRCA's answer keys, `query.csv` and `record.csv`, from the
 * published dataset archives. The archives hold about 8.8 GB, almost all of it
 * telemetry, so fetchOpenRcaData reads only these two files of each scenario. It
 * streams each file through SHA-256 and never holds a whole file in memory. A
 * file already on disk that matches stays, so a second run downloads nothing.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  archiveOf,
  dataFileSha256,
  driveArchives,
  type Archive,
  type DataFile,
} from "../pinned.js";
import {
  archiveEntry,
  openRcaScenarios,
  scenarioPath,
  type OpenRcaScenario,
} from "../scenarios.js";
import { removeOnDispose } from "../temp.js";
import { openRemoteZipEntry } from "./remote-zip.js";

/** A file at `path` that fetchOpenRcaData checked. `fetched` is false for a file that was already there. */
type FetchedFile = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly fetched: boolean;
};

/**
 * Makes sure that `<dataDir>/<scenario>/query.csv` and `record.csv` exist and
 * match their hashes, and returns one entry per file in the order of
 * `scenarios`, with `query.csv` first. It renames a download into place only
 * once its hash matches, so a failed or interrupted run never leaves a wrong
 * file under the final name.
 *
 * @throws Error if a file on disk or a downloaded file does not match its hash,
 *   or if a download fails.
 */
export async function fetchOpenRcaData({
  scenarios,
  dataDir,
  archives = driveArchives,
  sha256 = dataFileSha256,
}: {
  readonly scenarios: readonly OpenRcaScenario[];
  readonly dataDir: string;
  readonly archives?: Readonly<Record<keyof typeof driveArchives, Archive>>;
  readonly sha256?: Readonly<Record<DataFile, string>>;
}): Promise<FetchedFile[]> {
  const fetched: FetchedFile[] = [];
  for (const scenario of scenarios) {
    const archive = archives[archiveOf[openRcaScenarios[scenario]]];
    for (const file of ["query.csv", "record.csv"] as const) {
      const entry = archiveEntry(scenario, file);
      const path = scenarioPath(dataDir, scenario, file);
      fetched.push(await ensureFile({ archive, entry, sha256: sha256[entry], path }));
    }
  }
  return fetched;
}

async function ensureFile({
  archive,
  entry,
  sha256,
  path,
}: {
  readonly archive: Archive;
  readonly entry: DataFile;
  readonly sha256: string;
  readonly path: string;
}): Promise<FetchedFile> {
  const local = await hashFile(path);
  if (local === undefined) {
    await mkdir(dirname(path), { recursive: true });
    await using temp = removeOnDispose(`${path}.tmp`);
    const source = await openRemoteZipEntry(archive.url, archive.bytes, entry);
    const downloaded = await copyHashed(source, temp.path);
    verify({
      entry,
      actual: downloaded,
      expected: sha256,
      problem: "the download is not the published file",
    });
    await rename(temp.path, path);
  } else {
    verify({
      entry,
      actual: local,
      expected: sha256,
      problem: `${path} is not the published file; delete it`,
    });
  }
  const { size } = await stat(path);
  return { path, bytes: size, sha256, fetched: local === undefined };
}

/** Returns the SHA-256 of the file at `path` in hex, or undefined if the file does not exist. */
async function hashFile(path: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return hash.digest("hex");
}

/** Streams `source` into a new file at `path` and returns the SHA-256 of its bytes in hex. */
async function copyHashed(source: Readable, path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(path),
  );
  return hash.digest("hex");
}

function verify({
  entry,
  actual,
  expected,
  problem,
}: {
  readonly entry: DataFile;
  readonly actual: string;
  readonly expected: string;
  readonly problem: string;
}): void {
  if (actual !== expected) {
    throw new Error(`${entry}: ${problem} (sha256 ${actual}, expected ${expected})`);
  }
}
