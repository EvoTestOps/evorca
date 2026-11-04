/**
 * Downloads OpenRCA's answer keys, `query.csv` and `record.csv`, from the
 * published dataset archives. The archives hold about 8.8 GB, almost all of it
 * telemetry, so fetchOpenRcaData reads only these two files of each system. It
 * streams each file through SHA-256 and never holds a whole file in memory. A
 * file already on disk that matches stays, so a second run downloads nothing.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  archiveOf,
  dataFileSha256,
  driveArchives,
  type Archive,
  type DataFile,
} from "../pinned.js";
import type { OpenRcaSystem } from "../tasks.js";
import { removeOnDispose } from "../temp.js";
import { openRemoteZipEntry } from "./remote-zip.js";

/** A file that fetchOpenRcaData checked. `fetched` is false for a file that was already on disk. */
type FetchedFile = {
  readonly file: DataFile;
  readonly bytes: number;
  readonly sha256: string;
  readonly fetched: boolean;
};

/**
 * Makes sure that `<dataDir>/<system>/query.csv` and `record.csv` exist and match
 * their hashes, and returns one entry per file in the order of `systems`, with
 * `query.csv` first. It renames a download into place only once its hash matches,
 * so a failed or interrupted run never leaves a wrong file under the final name.
 *
 * @throws Error if a file on disk or a downloaded file does not match its hash,
 *   or if a download fails.
 */
export async function fetchOpenRcaData({
  systems,
  dataDir,
  archives = driveArchives,
  sha256 = dataFileSha256,
}: {
  readonly systems: readonly OpenRcaSystem[];
  readonly dataDir: string;
  readonly archives?: Readonly<Record<keyof typeof driveArchives, Archive>>;
  readonly sha256?: Readonly<Record<DataFile, string>>;
}): Promise<FetchedFile[]> {
  const fetched: FetchedFile[] = [];
  for (const system of systems) {
    const archive = archives[archiveOf[system]];
    for (const file of [`${system}/query.csv`, `${system}/record.csv`] as const) {
      fetched.push(await ensureFile({ archive, file, sha256: sha256[file], dataDir }));
    }
  }
  return fetched;
}

async function ensureFile({
  archive,
  file,
  sha256,
  dataDir,
}: {
  readonly archive: Archive;
  readonly file: DataFile;
  readonly sha256: string;
  readonly dataDir: string;
}): Promise<FetchedFile> {
  const path = join(dataDir, file);
  const local = await hashFile(path);
  if (local === undefined) {
    await mkdir(dirname(path), { recursive: true });
    await using temp = removeOnDispose(`${path}.tmp`);
    const entry = await openRemoteZipEntry(archive.url, archive.bytes, file);
    const downloaded = await copyHashed(entry, temp.path);
    verify({
      file,
      actual: downloaded,
      expected: sha256,
      problem: "the download is not the published file",
    });
    await rename(temp.path, path);
  } else {
    verify({
      file,
      actual: local,
      expected: sha256,
      problem: `${path} is not the published file; delete it`,
    });
  }
  const { size } = await stat(path);
  return { file, bytes: size, sha256, fetched: local === undefined };
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
  file,
  actual,
  expected,
  problem,
}: {
  readonly file: DataFile;
  readonly actual: string;
  readonly expected: string;
  readonly problem: string;
}): void {
  if (actual !== expected) {
    throw new Error(`${file}: ${problem} (sha256 ${actual}, expected ${expected})`);
  }
}
