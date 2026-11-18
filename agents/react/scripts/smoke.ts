/**
 * `pnpm --filter @evorca/agent-react smoke` runs the agent's image on one
 * task, as the runner would, against a scripted Messages API, and fails unless
 * the agent writes all three files with the expected answer.
 *
 * The image runs with the runner's restrictions: a read-only root, the user
 * `nobody`, a tmpfs at `/tmp`, no capabilities, and limits on memory, CPU, and
 * processes. Its only network is an internal Docker network that reaches the
 * mock and nothing else. The telemetry is a few megabytes of synthetic
 * Telecom metrics in the schema that RCA-Agent's prompt describes.
 *
 * The scripted model runs three commands: one that reports the user, the
 * environment, and the read-only root, a DuckDB query over the metrics, and a
 * pandas script saved to `/tmp`. Then it submits an answer.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parsePrediction } from "../../../packages/openrca/src/prediction.ts";
import { bashCall, message, submitCall } from "../test/mock-api.ts";

const run = promisify(execFile);
const docker = (...args: string[]) => run("docker", args, { maxBuffer: 64 * 1024 * 1024 });

const agentDir = fileURLToPath(new URL("..", import.meta.url));
const image = "evorca-agent-react:smoke";
const network = `evorca-smoke-${process.pid}`;
const mockName = `${network}-mock`;
const agentName = `${network}-agent`;
const day = Date.UTC(2020, 3, 10, 16);
const faultStart = day + 5 * 60_000;

const commands = {
  sandbox:
    'id -u; echo "HOME=$HOME"; env | grep -c -E "^(ANTHROPIC|EVORCA)_"; cat /proc/self/oom_score_adj; touch /probe',
  duckdb: `python3 -c "import duckdb; duckdb.sql(\\"SELECT cmdb_id, max(value) AS peak, arg_max(timestamp, value) AS at FROM read_csv('/data/2020_04_11/metric/metric_container.csv') WHERE name = 'container_cpu_used' GROUP BY cmdb_id ORDER BY peak DESC LIMIT 1\\").show()"`,
  pandas: [
    "cat > first.py <<'EOF'",
    "import pandas as pd, pytz",
    "df = pd.read_csv('/data/2020_04_11/metric/metric_container.csv')",
    "cpu = df[(df.name == 'container_cpu_used') & (df.cmdb_id == 'docker_003') & (df.value > 50)]",
    "first = pd.to_datetime(cpu.timestamp.min(), unit='ms', utc=True).tz_convert(pytz.timezone('Asia/Shanghai'))",
    "print(first.strftime('%Y-%m-%d %H:%M:%S'))",
    "EOF",
    "python3 first.py",
  ].join("\n"),
};

const replies = [
  message([bashCall(commands.sandbox)]),
  message([bashCall(commands.duckdb)]),
  message([bashCall(commands.pandas)]),
  message([
    submitCall([
      { occurrence_datetime: "2020-04-11 00:05:00", component: "docker_003", reason: "CPU fault" },
    ]),
  ]),
];

const task = {
  scenario: "telecom",
  row: 0,
  taskIndex: "task_7",
  instruction:
    "On April 11, 2020, within the time range of 00:00 to 00:30, there was one failure. Identify the root cause component, the root cause reason, and the root cause occurrence datetime.",
  candidates: {
    components: ["docker_001", "docker_002", "docker_003", "os_001"],
    reasons: ["CPU fault", "network delay", "db connection limit"],
  },
};

function telemetry(): string {
  const rows = ["itemid,name,bomc_id,timestamp,value,cmdb_id"];
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const timestamp = day + minute * 60_000;
    for (const container of ["docker_001", "docker_002", "docker_003"]) {
      for (const [item, kpi] of [
        [999999996381330, "container_cpu_used"],
        [999999996381331, "container_mem_used"],
        [999999996381332, "container_fgc"],
        [999999996381333, "container_thread_running"],
      ] as const) {
        const faulty =
          container === "docker_003" &&
          kpi === "container_cpu_used" &&
          timestamp >= faultStart &&
          timestamp < faultStart + 10 * 60_000;
        const value = faulty ? 95 + (minute % 3) : 20 + ((minute * 7 + kpi.length) % 13);
        for (let second = 0; second < 60; second += 15) {
          rows.push(
            `${item},${kpi},ZJ-004-060,${timestamp + second * 1000},${value.toFixed(6)},${container}`,
          );
        }
      }
    }
  }
  return `${rows.join("\n")}\n`;
}

const work = await mkdtemp(join(tmpdir(), "evorca-smoke-"));
try {
  console.log(`Building ${image}`);
  await docker("build", "--quiet", "--tag", image, agentDir);
  const [{ stdout: size }] = await Promise.all([
    docker("image", "ls", "--format", "{{.Size}}", image),
    mkdir(join(work, "data", "2020_04_11", "metric"), { recursive: true }),
    mkdir(join(work, "out")),
    mkdir(join(work, "mock")),
  ]);
  console.log(`Image size: ${size.trim()}`);
  const csv = telemetry();
  console.log(`Telemetry: ${(csv.length / 1e6).toFixed(1)} MB`);
  await Promise.all([
    writeFile(join(work, "data", "2020_04_11", "metric", "metric_container.csv"), csv),
    writeFile(join(work, "task.json"), JSON.stringify(task)),
    writeFile(join(work, "mock", "replies.json"), JSON.stringify(replies)),
    readFile(join(agentDir, "test", "mock-api.ts")).then((source) =>
      writeFile(join(work, "mock", "mock-api.ts"), source),
    ),
  ]);
  const nodeImage = await baseImage();

  await docker("network", "create", "--internal", network);
  await docker(
    "run",
    "--detach",
    "--name",
    mockName,
    "--network",
    network,
    "--read-only",
    "--user",
    "65534:65534",
    "--mount",
    `type=bind,src=${join(work, "mock")},dst=/mock,readonly`,
    "--entrypoint",
    "node",
    nodeImage,
    "/mock/mock-api.ts",
    "/mock/replies.json",
    "8080",
  );

  const started = Date.now();
  const agent = await docker(
    "run",
    "--rm",
    "--init",
    "--name",
    agentName,
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=1g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--memory",
    "3g",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--mount",
    `type=bind,src=${join(work, "task.json")},dst=/task.json,readonly`,
    "--mount",
    `type=bind,src=${join(work, "out")},dst=/out`,
    "--mount",
    `type=bind,src=${join(work, "data")},dst=/data,readonly`,
    "--env",
    `ANTHROPIC_BASE_URL=http://${mockName}:8080`,
    "--env",
    "ANTHROPIC_API_KEY=smoke-token",
    "--env",
    "EVORCA_SEED=1",
    "--env",
    "EVORCA_TASK_BUDGET_USD=1",
    image,
  );
  console.log(`Agent: ${agent.stdout.trim()} (${((Date.now() - started) / 1000).toFixed(1)} s)`);

  const out = (file: string) => readFile(join(work, "out", file), "utf8");
  const prediction = parsePrediction(await out("prediction.json"));
  const summary = JSON.parse(await out("summary.json"));
  const tools = (await out("trajectory.jsonl"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "tool");
  const outputs = tools.map((event) => String(event.output));

  for (const [i, output] of outputs.entries()) console.log(`\n--- tool ${i + 1}\n${output}`);
  check("prediction.json is a valid prediction", prediction?.length === 1);
  check(
    "summary.json reports the submitted answer",
    summary.stopCause === "submitted" && summary.steps === 4,
  );
  check(
    "the commands ran as nobody",
    outputs[0]?.startsWith("65534\nHOME=/tmp\n0\n1000\n") === true,
  );
  check("the root is read-only", outputs[0]?.includes("Read-only file system") === true);
  check(
    "DuckDB read the telemetry",
    outputs[1]?.includes("docker_003") === true && outputs[1]?.includes("97.0") === true,
  );
  check("pandas found the fault in UTC+8", outputs[2] === "2020-04-11 00:05:00\n");
  console.log("\nSmoke test passed");
} finally {
  await docker("rm", "--force", mockName, agentName).catch(() => {});
  await docker("network", "rm", network).catch(() => {});
  await rm(work, { recursive: true, force: true });
}

function check(claim: string, ok: boolean): void {
  if (!ok) throw new Error(`Smoke test failed: ${claim}`);
  console.log(`ok: ${claim}`);
}

async function baseImage(): Promise<string> {
  const dockerfile = await readFile(join(agentDir, "Dockerfile"), "utf8");
  const from = /^FROM (\S+)/m.exec(dockerfile)?.[1];
  if (from === undefined) throw new Error("The Dockerfile has no FROM line");
  return from;
}
