/**
 * Downloads the files of OpenRCA scenarios from the published dataset archives:
 * the answer keys, `query.csv` and `record.csv`, and the telemetry, which is
 * almost all of the 69 GB that the archives hold once unpacked. Each file
 * streams through SHA-256 and never sits whole in memory. A file already on
 * disk that matches stays, so a second run downloads nothing.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  archiveOf,
  answerKeyFiles,
  driveArchives,
  telemetryFiles,
  type Archive,
  type FileDigest,
} from "../pinned.js";
import { openRcaScenarios, type OpenRcaScenario } from "../scenarios.js";
import { removeOnDispose } from "../temp.js";
import { openRemoteZip, type RemoteZip } from "./remote-zip.js";

/**
 * One step of fetchOpenRcaData for the file at `path`: the file is `present`,
 * or fetchOpenRcaData starts `fetching` it, or it has `fetched` it. `bytes` and
 * `sha256` are the pinned values, which a present or fetched file matches.
 */
export type FileProgress = FileDigest & {
  readonly status: "present" | "fetching" | "fetched";
  readonly path: string;
};

type Target = FileDigest & {
  readonly archive: keyof typeof driveArchives;
  readonly entry: string;
  readonly path: string;
};

/**
 * Makes sure that each pinned file of `scenarios` exists in `dataDir` and
 * matches its size and SHA-256, and yields the progress of each file. The file
 * at `<System>/<path>` in an archive lands at `<dataDir>/<scenario>/<path>`, so
 * the telemetry of `telecom` lands in `<dataDir>/telecom/telemetry/`.
 *
 * It renames a download into place only once it matches, so a failed or
 * interrupted run never leaves a wrong file under the final name.
 *
 * @param files - The pinned files by their path in the archives. Each scenario
 *   gets the files under its system's directory.
 * @throws Error if a file on disk does not match or the missing files do not
 *   fit, before any download, or if a download fails or does not match.
 */
export async function* fetchOpenRcaData({
  scenarios,
  dataDir,
  archives = driveArchives,
  files = { ...answerKeyFiles, ...telemetryFiles },
}: {
  readonly scenarios: readonly OpenRcaScenario[];
  readonly dataDir: string;
  readonly archives?: Readonly<Record<keyof typeof driveArchives, Archive>>;
  readonly files?: Readonly<Record<string, FileDigest>>;
}): AsyncGenerator<FileProgress, void, undefined> {
  const missing: Target[] = [];
  for (const scenario of new Set(scenarios)) {
    for (const target of targetsOf(scenario, dataDir, files)) {
      const local = await measureFile(target.path);
      if (local === undefined) {
        missing.push(target);
      } else {
        verify(target, local, `${target.path} is not the published file; delete it`);
        yield progress("present", target);
      }
    }
  }
  await ensureSpace(
    dataDir,
    missing.reduce((bytes, target) => bytes + target.bytes, 0),
  );
  for (const [name, targets] of Map.groupBy(missing, (target) => target.archive)) {
    const zip = await openRemoteZip(archives[name].url, archives[name].bytes);
    for (const target of targets) {
      yield progress("fetching", target);
      await download(zip, target);
      yield progress("fetched", target);
    }
  }
}

/** Returns the size and SHA-256 of the bytes in `chunks`. */
export async function measure(chunks: AsyncIterable<Buffer>): Promise<FileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function targetsOf(
  scenario: OpenRcaScenario,
  dataDir: string,
  files: Readonly<Record<string, FileDigest>>,
): Target[] {
  const system = openRcaScenarios[scenario];
  const systemDir = `${system}/`;
  return Object.entries(files)
    .filter(([entry]) => entry.startsWith(systemDir))
    .map(([entry, file]) => ({
      ...file,
      archive: archiveOf[system],
      entry,
      path: join(dataDir, scenario, entry.slice(systemDir.length)),
    }));
}

function progress(status: FileProgress["status"], { path, bytes, sha256 }: Target): FileProgress {
  return { status, path, bytes, sha256 };
}

async function measureFile(path: string): Promise<FileDigest | undefined> {
  try {
    return await measure(createReadStream(path));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureSpace(dataDir: string, bytes: number): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const { bavail, bsize } = await statfs(dataDir);
  const free = bavail * bsize;
  if (bytes > free) {
    throw new Error(
      `The missing files need ${gb(bytes)} GB, but ${dataDir} has ${gb(free)} GB free`,
    );
  }
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(2);
}

async function download(zip: RemoteZip, target: Target): Promise<void> {
  await mkdir(dirname(target.path), { recursive: true });
  await using temp = removeOnDispose(`${target.path}.tmp`);
  const downloaded = await copyMeasured(await zip.open(target.entry), temp.path);
  verify(target, downloaded, "the download is not the published file");
  await rename(temp.path, target.path);
}

async function copyMeasured(source: Readable, path: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(path),
  );
  return { bytes, sha256: hash.digest("hex") };
}

function verify(target: Target, actual: FileDigest, problem: string): void {
  if (actual.bytes !== target.bytes || actual.sha256 !== target.sha256) {
    const found = `${actual.bytes} bytes, sha256 ${actual.sha256}`;
    const expected = `${target.bytes} bytes, sha256 ${target.sha256}`;
    throw new Error(`${target.entry}: ${problem} (${found}; expected ${expected})`);
  }
}
