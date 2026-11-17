/**
 * Reads files out of a zip archive on a web server without downloading the
 * whole archive. A zip archive ends with a directory of its entries, so a reader
 * needs only that directory and the entries it wants, which HTTP Range requests
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

/** A zip archive on a web server whose directory has been read. */
export type RemoteZip = {
  readonly fileNames: readonly string[];
  open(fileName: string): Promise<Readable>;
};

/**
 * Reads the directory of a zip archive over HTTP. `fileNames` lists its
 * entries, and `open` streams the uncompressed contents of one entry.
 *
 * @param url - The archive's URL. Its server must answer Range requests with a
 *   `content-range` header.
 * @param bytes - The size of the archive. Every response must report this
 *   total, so a changed archive fails instead of returning other bytes.
 * @throws Error if a response does not cover the requested range of a
 *   `bytes`-long file. `open` and its stream fail in the same way, and `open`
 *   also fails if the archive has no entry named `fileName`.
 */
export async function openRemoteZip(url: string, bytes: number): Promise<RemoteZip> {
  const zip = await yauzl.fromRandomAccessReaderPromise(new RemoteFile(url, bytes), bytes, {
    lazyEntries: true,
    autoClose: false,
  });
  const entries = new Map<string, yauzl.Entry>();
  for await (const entry of zip.eachEntry()) entries.set(entry.fileName, entry);
  return {
    fileNames: [...entries.keys()],
    async open(fileName) {
      const entry = entries.get(fileName);
      if (entry === undefined) throw new Error(`${fileName} is not in ${url}`);
      return zip.openReadStreamPromise(entry);
    },
  };
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
