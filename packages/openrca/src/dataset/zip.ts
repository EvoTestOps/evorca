/**
 * Reads files out of a zip archive on disk or on a web server. A zip archive
 * ends with a directory of its entries, so a reader needs only that directory
 * and the entries it wants. On a web server, HTTP Range requests fetch only
 * those parts of the archive. There, reads of up to 1 MiB share one buffered
 * response, so the many small reads that yauzl makes cost one request. A
 * larger read streams from its own response, so memory use does not grow with
 * the size of an entry.
 *
 * @module
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import yauzl from "yauzl";

const windowBytes = 1024 * 1024;

/**
 * Where a zip archive's bytes come from: a web server at `url` that answers
 * HTTP Range requests with a `content-range` header, or a file at `path`.
 * `bytes` is the size of the archive.
 */
export type ZipSource = { readonly bytes: number } & (
  { readonly url: string } | { readonly path: string }
);

/** A zip archive whose directory has been read. */
export type Zip = {
  readonly fileNames: readonly string[];
  open(fileName: string): Promise<Readable>;
};

/**
 * The error that a read from a web server throws when the server answers a
 * Range request with 200 and a web page instead of the bytes, as Google Drive
 * does once a file's download quota is used up.
 */
export class DownloadRefusedError extends Error {}

/**
 * Reads the directory of a zip archive. `fileNames` lists its entries, and
 * `open` streams the uncompressed contents of one entry.
 *
 * @param source - The archive. Every response of a web server must report its
 *   `bytes` as the total, so a changed archive fails instead of returning other
 *   bytes.
 * @throws DownloadRefusedError if the web server answers with a web page.
 * @throws Error if a response does not cover the requested range of a
 *   `bytes`-long file. `open` and its stream fail in the same ways, and `open`
 *   also fails if the archive has no entry named `fileName`.
 */
export async function openZip(source: ZipSource): Promise<Zip> {
  const [location, reader] =
    "url" in source
      ? [source.url, new RemoteFile(source.url, source.bytes)]
      : [source.path, new LocalFile(source.path)];
  const zip = await yauzl.fromRandomAccessReaderPromise(reader, source.bytes, {
    lazyEntries: true,
    autoClose: false,
  });
  const entries = new Map<string, yauzl.Entry>();
  for await (const entry of zip.eachEntry()) entries.set(entry.fileName, entry);
  return {
    fileNames: [...entries.keys()],
    async open(fileName) {
      const entry = entries.get(fileName);
      if (entry === undefined) throw new Error(`${fileName} is not in ${location}`);
      return zip.openReadStreamPromise(entry);
    },
  };
}

class LocalFile extends yauzl.RandomAccessReader {
  constructor(readonly path: string) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    return createReadStream(this.path, { start, end: end - 1 });
  }
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
    if (response.status === 200 && response.headers.get("content-type")?.startsWith("text/html")) {
      throw new DownloadRefusedError(`${this.url} answered bytes ${range} with a web page`);
    }
    const contentRange = response.headers.get("content-range");
    if (contentRange !== `bytes ${range}/${this.size}` || response.body === null) {
      throw new Error(
        `${this.url} answered bytes ${range} with ${response.status} ${contentRange}`,
      );
    }
    return response.body;
  }
}
