/**
 * Reads one file out of a zip archive on a web server without downloading the
 * whole archive.
 *
 * A zip archive ends with a directory of its entries, so a reader needs only
 * that directory and the entry it wants. HTTP Range requests fetch those parts.
 * Each request fetches at least 1 MiB, so the many small reads that yauzl makes
 * share one response.
 *
 * @module
 */
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import yauzl from "yauzl";

/**
 * Reads one entry of a zip archive over HTTP.
 *
 * @param url - The archive's URL. Its server must answer Range requests with a
 *   `content-range` header.
 * @param bytes - The size of the archive. Every response must report this
 *   total, so a changed archive fails instead of returning other bytes.
 * @param fileName - The path of the entry inside the archive.
 * @returns The entry's uncompressed contents.
 * @throws Error if a response does not cover the requested range of a
 *   `bytes`-long file, or if the archive has no entry named `fileName`.
 */
export async function readRemoteZipEntry(
  url: string,
  bytes: number,
  fileName: string,
): Promise<Buffer> {
  const zip = await yauzl.fromRandomAccessReaderPromise(new RemoteFile(url, bytes), bytes, {
    lazyEntries: true,
  });
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName === fileName) return buffer(await zip.openReadStreamPromise(entry));
  }
  throw new Error(`${fileName} is not in ${url}`);
}

class RemoteFile extends yauzl.RandomAccessReader {
  #start = 0;
  #window = Buffer.alloc(0);

  constructor(
    readonly url: string,
    readonly size: number,
  ) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    return Readable.from(this.#read(start, end), { objectMode: false });
  }

  async *#read(start: number, end: number) {
    if (start < this.#start || end > this.#start + this.#window.length) {
      const last = Math.min(this.size, Math.max(end, start + 1024 * 1024)) - 1;
      const response = await fetch(this.url, { headers: { Range: `bytes=${start}-${last}` } });
      const range = response.headers.get("content-range");
      if (range !== `bytes ${start}-${last}/${this.size}`) {
        throw new Error(
          `${this.url} answered bytes ${start}-${last} with ${response.status} ${range}`,
        );
      }
      this.#start = start;
      this.#window = Buffer.from(await response.arrayBuffer());
    }
    yield this.#window.subarray(start - this.#start, end - this.#start);
  }
}
