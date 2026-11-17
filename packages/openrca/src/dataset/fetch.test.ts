import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { describe, expect, it, onTestFinished } from "vitest";
import yazl from "yazl";
import { dataFileSha256, driveArchives } from "../pinned.js";
import { fetchOpenRcaData } from "./fetch.js";

const query = Buffer.from('task_index,instruction,scoring_points\ntask_3,Find it.,"The only"\n');
const record = Buffer.from("level,reason,component,timestamp,datetime\n");

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function zipOf(files: Record<string, Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, contents] of Object.entries(files)) zip.addBuffer(contents, name);
  zip.end();
  return buffer(zip.outputStream);
}

async function serve(body: Buffer, { reportedTotal = body.length } = {}) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (range === null) {
      response.writeHead(200).end(body);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), body.length - 1);
    response
      .writeHead(206, { "content-range": `bytes ${start}-${end}/${reportedTotal}` })
      .end(body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/market.zip`, requests: () => requests };
}

async function setUp({
  queryCsv = query,
  reportedTotal,
}: { queryCsv?: Buffer; reportedTotal?: number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "openrca-"));
  onTestFinished(() => rm(dataDir, { recursive: true }));
  const zip = await zipOf({
    "Market/cloudbed-1/query.csv": queryCsv,
    "Market/cloudbed-1/record.csv": record,
  });
  const server = await serve(zip, { reportedTotal });
  return {
    dataDir,
    server,
    archives: { ...driveArchives, Market: { url: server.url, bytes: zip.length } },
    hashes: {
      ...dataFileSha256,
      "Market/cloudbed-1/query.csv": sha256(queryCsv),
      "Market/cloudbed-1/record.csv": sha256(record),
    },
  };
}

describe("fetchOpenRcaData", () => {
  it("extracts each file from the system's directory in its archive into the scenario's directory", async () => {
    const { dataDir, archives, hashes } = await setUp();
    const queryPath = join(dataDir, "market-cloudbed-1", "query.csv");
    const recordPath = join(dataDir, "market-cloudbed-1", "record.csv");

    expect(
      await fetchOpenRcaData({
        scenarios: ["market-cloudbed-1"],
        dataDir,
        archives,
        sha256: hashes,
      }),
    ).toEqual([
      { path: queryPath, bytes: query.length, sha256: sha256(query), fetched: true },
      { path: recordPath, bytes: record.length, sha256: sha256(record), fetched: true },
    ]);
    expect(await readFile(queryPath)).toEqual(query);
    expect(await readFile(recordPath)).toEqual(record);
  });

  it("keeps files that are already present without downloading them again", async () => {
    const { dataDir, server, archives, hashes } = await setUp();
    await fetchOpenRcaData({ scenarios: ["market-cloudbed-1"], dataDir, archives, sha256: hashes });
    const requests = server.requests();

    const again = await fetchOpenRcaData({
      scenarios: ["market-cloudbed-1"],
      dataDir,
      archives,
      sha256: hashes,
    });

    expect(again.map((file) => file.fetched)).toEqual([false, false]);
    expect(server.requests()).toBe(requests);
  });

  it("rejects a download whose hash differs from the pinned hash and writes nothing", async () => {
    const { dataDir, archives, hashes } = await setUp();
    const wrong = { ...hashes, "Market/cloudbed-1/query.csv": sha256(Buffer.from("other")) };

    await expect(
      fetchOpenRcaData({ scenarios: ["market-cloudbed-1"], dataDir, archives, sha256: wrong }),
    ).rejects.toThrow("Market/cloudbed-1/query.csv");
    const entries = await readdir(dataDir, { recursive: true, withFileTypes: true });
    expect(entries.filter((entry) => entry.isFile())).toEqual([]);
  });

  it("streams an entry larger than the 1 MiB read window", async () => {
    const queryCsv = randomBytes(3 * 1024 * 1024);
    const { dataDir, archives, hashes } = await setUp({ queryCsv });

    await fetchOpenRcaData({ scenarios: ["market-cloudbed-1"], dataDir, archives, sha256: hashes });

    expect(sha256(await readFile(join(dataDir, "market-cloudbed-1", "query.csv")))).toBe(
      sha256(queryCsv),
    );
  });

  it("rejects an archive whose size differs from the pinned size", async () => {
    const { dataDir, server, archives, hashes } = await setUp({ reportedTotal: 1_000_000 });

    await expect(
      fetchOpenRcaData({ scenarios: ["market-cloudbed-1"], dataDir, archives, sha256: hashes }),
    ).rejects.toThrow(server.url);
  });
});
