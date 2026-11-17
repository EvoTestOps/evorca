import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { describe, expect, it, onTestFinished } from "vitest";
import yazl from "yazl";
import { driveArchives } from "../pinned.js";
import { fetchOpenRcaData } from "./fetch.js";

const query = Buffer.from('task_index,instruction,scoring_points\ntask_3,Find it.,"The only"\n');
const record = Buffer.from("level,reason,component,timestamp,datetime\n");
const metric = Buffer.from("timestamp,cmdb_id,kpi_name,value\n1647705600,node-1,cpu,0.5\n");
const trace = Buffer.from("timestamp,cmdb_id,parent_id,span_id,trace_id,duration\n");

const telemetry = "Market/cloudbed-1/telemetry";
const metricEntry = `${telemetry}/2022_03_20/metric/metric_app.csv`;
const traceEntry = `${telemetry}/2022_03_21/trace/trace_span.csv`;

const pin = (bytes: Buffer) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

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
    "Market/cloudbed-1/.DS_Store": Buffer.from("finder"),
    [`${telemetry}/.DS_Store`]: Buffer.from("finder"),
    [`${telemetry}/2022_03_20/.DS_Store`]: Buffer.from("finder"),
    [metricEntry]: metric,
    [traceEntry]: trace,
    [`${telemetry}/2022_03_21/metric/unpinned.csv`]: Buffer.from("a,b\n"),
    "Market/cloudbed-2/telemetry/2022_03_20/metric/metric_app.csv": metric,
  });
  const server = await serve(zip, { reportedTotal });
  return {
    dataDir,
    server,
    archives: { ...driveArchives, Market: { url: server.url, bytes: zip.length } },
    files: {
      "Market/cloudbed-1/query.csv": pin(queryCsv),
      "Market/cloudbed-1/record.csv": pin(record),
      [metricEntry]: pin(metric),
      [traceEntry]: pin(trace),
      "Market/cloudbed-2/telemetry/2022_03_20/metric/metric_app.csv": pin(metric),
    },
  };
}

function fetchAll(options: Parameters<typeof fetchOpenRcaData>[0]) {
  return Array.fromAsync(fetchOpenRcaData(options));
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe("fetchOpenRcaData", () => {
  it("writes each pinned file of the scenario below the scenario's directory and nothing else", async () => {
    const { dataDir, archives, files } = await setUp();
    const scenarioDir = join(dataDir, "market-cloudbed-1");
    const expected = [
      { path: join(scenarioDir, "query.csv"), contents: query },
      { path: join(scenarioDir, "record.csv"), contents: record },
      {
        path: join(scenarioDir, "telemetry", "2022_03_20", "metric", "metric_app.csv"),
        contents: metric,
      },
      {
        path: join(scenarioDir, "telemetry", "2022_03_21", "trace", "trace_span.csv"),
        contents: trace,
      },
    ];

    const progress = await fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files });

    expect(progress).toEqual(
      expected.flatMap(({ path, contents }) => [
        { status: "fetching", path, ...pin(contents) },
        { status: "fetched", path, ...pin(contents) },
      ]),
    );
    expect(await filesIn(dataDir)).toEqual(expected.map(({ path }) => path).sort());
    for (const { path, contents } of expected) expect(await readFile(path)).toEqual(contents);
  });

  it("writes each scenario of a shared archive to its own directory", async () => {
    const { dataDir, archives, files } = await setUp();

    const progress = await fetchAll({
      scenarios: ["market-cloudbed-2", "market-cloudbed-1"],
      dataDir,
      archives,
      files,
    });

    const cloudbed2Metric = join(
      dataDir,
      "market-cloudbed-2",
      "telemetry",
      "2022_03_20",
      "metric",
      "metric_app.csv",
    );
    expect(progress.filter((file) => file.status === "fetched").map((file) => file.path)).toEqual([
      cloudbed2Metric,
      join(dataDir, "market-cloudbed-1", "query.csv"),
      join(dataDir, "market-cloudbed-1", "record.csv"),
      join(dataDir, "market-cloudbed-1", "telemetry", "2022_03_20", "metric", "metric_app.csv"),
      join(dataDir, "market-cloudbed-1", "telemetry", "2022_03_21", "trace", "trace_span.csv"),
    ]);
    expect(await readFile(cloudbed2Metric)).toEqual(metric);
  });

  it("keeps files that are already present without downloading them again", async () => {
    const { dataDir, server, archives, files } = await setUp();
    await fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files });
    const requests = server.requests();

    const again = await fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files });

    expect(again.map((file) => file.status)).toEqual(["present", "present", "present", "present"]);
    expect(server.requests()).toBe(requests);
  });

  it("rejects a download whose hash differs from the pinned hash and writes nothing", async () => {
    const { dataDir, archives, files } = await setUp();
    const wrong = { ...files, "Market/cloudbed-1/query.csv": pin(Buffer.from("other")) };

    await expect(
      fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files: wrong }),
    ).rejects.toThrow("Market/cloudbed-1/query.csv");
    expect(await filesIn(dataDir)).toEqual([]);
  });

  it("names a present file that differs from the pinned file and downloads nothing", async () => {
    const { dataDir, server, archives, files } = await setUp();
    await fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files });
    const changed = join(
      dataDir,
      "market-cloudbed-1",
      "telemetry",
      "2022_03_20",
      "metric",
      "metric_app.csv",
    );
    await writeFile(changed, "edited\n");
    await rm(join(dataDir, "market-cloudbed-1", "telemetry", "2022_03_21"), { recursive: true });
    const requests = server.requests();

    await expect(
      fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files }),
    ).rejects.toThrow(changed);
    expect(server.requests()).toBe(requests);
  });

  it("refuses to download anything when the missing files need more than the free space", async () => {
    const { dataDir, server, archives, files } = await setUp();
    const huge = { ...files, [traceEntry]: { ...pin(trace), bytes: 10 ** 18 } };

    await expect(
      fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files: huge }),
    ).rejects.toThrow(/need 1000000000\.\d\d GB, but .* has \d+\.\d\d GB free/);
    expect(server.requests()).toBe(0);
    expect(await filesIn(dataDir)).toEqual([]);
  });

  it("streams an entry larger than the 1 MiB read window", async () => {
    const queryCsv = randomBytes(3 * 1024 * 1024);
    const { dataDir, archives, files } = await setUp({ queryCsv });

    await fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files });

    expect(pin(await readFile(join(dataDir, "market-cloudbed-1", "query.csv")))).toEqual(
      pin(queryCsv),
    );
  });

  it("rejects an archive whose size differs from the pinned size", async () => {
    const { dataDir, server, archives, files } = await setUp({ reportedTotal: 1_000_000 });

    await expect(
      fetchAll({ scenarios: ["market-cloudbed-1"], dataDir, archives, files }),
    ).rejects.toThrow(server.url);
  });
});

describe("fetchOpenRcaData with an archive on disk", () => {
  const entries = {
    "Telecom/query.csv": query,
    "Telecom/record.csv": record,
    "Telecom/telemetry/2020_04_11/metric/metric_service.csv": metric,
    "Telecom/telemetry/2020_04_11/trace/trace_span.csv": trace,
  };

  async function setUpLocal() {
    const [dataDir, downloads] = await Promise.all([
      mkdtemp(join(tmpdir(), "openrca-")),
      mkdtemp(join(tmpdir(), "openrca-downloads-")),
    ]);
    onTestFinished(() => rm(dataDir, { recursive: true }));
    onTestFinished(() => rm(downloads, { recursive: true }));
    const zip = await zipOf({
      ...entries,
      "Telecom/.DS_Store": Buffer.from("finder"),
      "Telecom/telemetry/2020_04_11/.DS_Store": Buffer.from("finder"),
    });
    const archivePath = join(downloads, "Telecom.zip");
    await writeFile(archivePath, zip);
    const server = await serve(zip);
    return {
      dataDir,
      downloads,
      archivePath,
      server,
      archives: {
        ...driveArchives,
        Telecom: { ...driveArchives.Telecom, url: server.url, bytes: zip.length },
      },
      files: Object.fromEntries(
        Object.entries(entries).map(([entry, bytes]) => [entry, pin(bytes)]),
      ),
    };
  }

  const pathIn = (dataDir: string, entry: string) =>
    join(dataDir, "telecom", entry.slice("Telecom/".length));

  it("writes each pinned file from the archive on disk and sends no request", async () => {
    const { dataDir, archivePath, server, archives, files } = await setUpLocal();

    const progress = await fetchAll({
      scenarios: ["telecom"],
      dataDir,
      archives,
      files,
      localArchives: [archivePath],
    });

    expect(progress).toEqual(
      Object.entries(entries).flatMap(([entry, contents]) => [
        { status: "fetching", path: pathIn(dataDir, entry), ...pin(contents) },
        { status: "fetched", path: pathIn(dataDir, entry), ...pin(contents) },
      ]),
    );
    expect(await filesIn(dataDir)).toEqual(
      Object.keys(entries)
        .map((entry) => pathIn(dataDir, entry))
        .sort(),
    );
    for (const [entry, contents] of Object.entries(entries)) {
      const written = await readFile(pathIn(dataDir, entry));
      expect(written).toEqual(contents);
      expect(createHash("sha256").update(written).digest("hex")).toBe(files[entry]?.sha256);
    }
    expect(server.requests()).toBe(0);
  });

  it("rejects a file whose hash differs from the pinned hash and keeps no file or .tmp for it", async () => {
    const { dataDir, archivePath, archives, files } = await setUpLocal();
    const metricEntry = "Telecom/telemetry/2020_04_11/metric/metric_service.csv";
    const wrong = { ...files, [metricEntry]: pin(Buffer.from("other")) };

    await expect(
      fetchAll({
        scenarios: ["telecom"],
        dataDir,
        archives,
        files: wrong,
        localArchives: [archivePath],
      }),
    ).rejects.toThrow(`${metricEntry}: the download is not the published file`);
    expect(await filesIn(dataDir)).toEqual([
      pathIn(dataDir, "Telecom/query.csv"),
      pathIn(dataDir, "Telecom/record.csv"),
    ]);
  });

  it("rejects an archive whose size matches no pinned archive and names the archives", async () => {
    const { dataDir, downloads, archives, files } = await setUpLocal();
    const other = await zipOf({ "Telecom/query.csv": query });
    const otherPath = join(downloads, "other.zip");
    await writeFile(otherPath, other);

    await expect(
      fetchAll({ scenarios: ["telecom"], dataDir, archives, files, localArchives: [otherPath] }),
    ).rejects.toHaveProperty(
      "message",
      `${otherPath} has ${other.length} bytes, but the OpenRCA archives are ` +
        `Bank.zip (${archives.Bank.bytes} bytes), Telecom.zip (${archives.Telecom.bytes} bytes), ` +
        `and Market.zip (${archives.Market.bytes} bytes)`,
    );
    expect(await filesIn(dataDir)).toEqual([]);
  });
});
