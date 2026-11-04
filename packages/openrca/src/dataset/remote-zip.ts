/**
 * Reads one file out of a zip archive on a web server without downloading the
 * whole archive. A zip archive ends with a directory of its entries, so a reader
 * needs only that directory and the entry it wants, which HTTP Range requests
 * fetch. Reads of up to 1 MiB share one buffered response, so the many small
 * reads that yauzl makes cost one request. A larger read streams from its own
 * response, so memory use does not grow with the size of an entry.
 *
 * @module
 */
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import yauzl from "yauzl";

const windowBytes = 1024 * 1024;

/**
 * Opens one entry of a zip archive over HTTP as a stream of its uncompressed
 * contents.
 *
 * @param url - The archive's URL. Its server must answer Range requests with a
 *   `content-range` header.
 * @param bytes - The size of the archive. Every response must report this
 *   total, so a changed archive fails instead of returning other bytes.
 * @throws Error if a response does not cover the requested range of a
 *   `bytes`-long file, or if the archive has no entry named `fileName`. The
 *   stream fails in the same way for a response that it reads later.
 */
export async function openRemoteZipEntry(
  url: string,
  bytes: number,
  fileName: string,
): Promise<Readable> {
  const zip = await yauzl.fromRandomAccessReaderPromise(new RemoteFile(url, bytes), bytes, {
    lazyEntries: true,
  });
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName === fileName) return zip.openReadStreamPromise(entry);
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
    if (end - start > windowBytes) {
      yield* await this.#fetch(start, end);
      return;
    }
    if (start < this.#start || end > this.#start + this.#window.length) {
      this.#window = await buffer(
        await this.#fetch(start, Math.min(this.size, start + windowBytes)),
      );
      this.#start = start;
    }
    yield this.#window.subarray(start - this.#start, end - this.#start);
  }

  async #fetch(start: number, end: number): Promise<ReadableStream<Uint8Array>> {
    const range = `${start}-${end - 1}`;
    const response = await fetch(this.url, { headers: { Range: `bytes=${range}` } });
    const contentRange = response.headers.get("content-range");
    if (contentRange !== `bytes ${range}/${this.size}` || response.body === null) {
      throw new Error(
        `${this.url} answered bytes ${range} with ${response.status} ${contentRange}`,
      );
    }
    return response.body;
  }
}
