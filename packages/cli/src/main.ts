/**
 * The `evorca` command, which `pnpm evorca` runs from the repository root.
 * Without arguments, `evorca` opens the interactive shell full screen, and
 * exits with code 1 when stdin or stdout is not a terminal. It loads the shell
 * on demand, so the other commands never load OpenTUI's native library. The
 * shell's `/benchmark` runs `openrca` evaluations in the shell's process.
 * `evorca fetch` downloads the data of a benchmark's scenarios, the answer keys
 * and the telemetry, into `data/benchmarks/<benchmark>/<scenario>/` at the
 * repository root.
 * `evorca reproduce` downloads only the answer keys of those scenarios, checks
 * that evorca reproduces the scores that the benchmark publishes, and keeps the
 * scorer's checkout and environment in `.cache/` at the repository root.
 * Both read the files of each dataset archive given as `--archive=<path>` from
 * that copy on disk instead of downloading them.
 * `evorca evaluate` runs an agent from `agents/` on those scenarios, one Docker
 * container per task, scores its answers, and keeps each run in
 * `data/runs/<benchmark>/<scenario>/`. In a terminal, it shows the run in the
 * view of `evorca watch` unless `--plain` asks for lines. On SIGINT or
 * SIGTERM, it stops the run and exits with 130 or 143. `evorca report` prints
 * the summary of finished runs from those folders. `evorca watch` shows a run
 * full screen while it runs, from its folder, and follows the newest run
 * without a run ID. With the ID of a run that does not exist, it exits with
 * code 1.
 *
 * The command takes the real API key from `ANTHROPIC_API_KEY` and then deletes
 * the variable, so no Docker command, container, or evaluator that it starts
 * inherits the key. `pnpm evorca` loads the variable from `.env` at the
 * repository root if the file exists. `EVORCA_UPSTREAM_URL` replaces the
 * Anthropic API for the model proxy, such as with a mock. It must use https,
 * or http on a loopback address, so the key never crosses a network in clear.
 *
 * @module
 */
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openRcaScenarios } from "@evorca/openrca";
import { answerKeyFiles, fetchOpenRcaData, type FileProgress } from "@evorca/openrca/dataset";
import { agents } from "./agents.js";
import { efforts, models } from "./models.js";
import { evaluateOpenRca, reproduceOpenRca } from "./openrca.js";
import { reportRuns } from "./report.js";
import { isRunId, parseRows } from "./runs.js";
import { missingRun } from "./watch-folder.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const benchmarks = {
  openrca: {
    scenarios: openRcaScenarios,
    answerKeys: answerKeyFiles,
    fetch: fetchOpenRcaData,
    reproduce: reproduceOpenRca,
    evaluate: evaluateOpenRca,
    report: reportRuns,
  },
};

type Benchmark = (typeof benchmarks)[keyof typeof benchmarks];

type Invocation = {
  readonly benchmark: Benchmark;
  readonly scenarios: readonly (keyof Benchmark["scenarios"])[];
  readonly runIds: readonly string[];
  readonly flags: Flags;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly runsDir: string;
  readonly agentsDir: string;
};

const commands = {
  async fetch({ benchmark, scenarios, flags, dataDir }: Invocation) {
    const localArchives = flags.archive ?? [];
    await printProgress(benchmark.fetch({ scenarios, dataDir, localArchives }));
  },
  async reproduce({ benchmark, scenarios, flags, dataDir, cacheDir }: Invocation) {
    const files = benchmark.answerKeys;
    const localArchives = flags.archive ?? [];
    await printProgress(benchmark.fetch({ scenarios, dataDir, files, localArchives }));
    if (!(await benchmark.reproduce({ scenarios, dataDir, cacheDir }))) process.exitCode = 1;
  },
  async evaluate({ benchmark, scenarios, flags, runIds: _, ...dirs }: Invocation) {
    const resume = flags.resume === undefined ? undefined : parseRunId(flags.resume, "--resume");
    if (resume !== undefined && flags.runs !== undefined) {
      fail("--runs starts new runs. A resumed run keeps the number of runs it started with.");
    }
    const agent =
      flags.agent === undefined && resume !== undefined
        ? undefined
        : choose(agents, flags.agent, "agent");
    const rows = flags.rows === undefined ? undefined : parseRows(flags.rows, scenarios);
    if (typeof rows === "string") fail(rows);
    const options = {
      ...dirs,
      scenarios,
      agent,
      runs: flags.runs === undefined ? undefined : parseCount(flags.runs, "--runs"),
      resume,
      seed: readSeed(),
      rows,
      jobs: flags.jobs === undefined ? undefined : parseCount(flags.jobs, "--jobs"),
      model: flags.model === undefined ? undefined : choose(models, flags.model, "model"),
      effort: flags.effort === undefined ? undefined : chooseEffort(flags.effort),
      budgetUsd:
        flags["budget-usd"] === undefined
          ? undefined
          : parseUsd(flags["budget-usd"], "--budget-usd"),
      taskBudgetUsd:
        flags["task-budget-usd"] === undefined
          ? undefined
          : parseUsd(flags["task-budget-usd"], "--task-budget-usd"),
      apiKey,
      upstreamUrl: readUpstreamUrl(),
    };
    const stop = new AbortController();
    let stopSignal: NodeJS.Signals | undefined;
    const onSignal = (signal: NodeJS.Signals) => {
      stopSignal = signal;
      console.error("\nStopping. Press ctrl+c again to stop at once.");
      stop.abort();
    };
    process.once("SIGINT", onSignal).once("SIGTERM", onSignal);
    const run = (onRun?: (runId: string) => void) =>
      benchmark.evaluate({ ...options, signal: stop.signal, onRun });
    const fullScreen = !flags.plain && process.stdin.isTTY && process.stdout.isTTY;
    const view = fullScreen ? await import("./evaluate-view.js") : undefined;
    const evaluation =
      view === undefined ? run() : view.evaluateFullScreen({ ...dirs, scenarios }, run);
    const ok = await evaluation.finally(() => {
      process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
      if (stopSignal !== undefined) process.exit(stopSignal === "SIGINT" ? 130 : 143);
    });
    if (!ok) process.exitCode = 1;
  },
  async report({ benchmark, scenarios, runIds, runsDir }: Invocation) {
    if (!(await benchmark.report({ scenarios, runIds, runsDir }))) process.exitCode = 1;
  },
  async watch({ scenarios, runIds: [runId], dataDir, runsDir }: Invocation) {
    const missing =
      runId === undefined ? undefined : await missingRun({ runsDir, scenarios }, runId);
    if (missing !== undefined) fail(missing);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail("evorca watch needs an interactive terminal.");
    }
    const { openWatch } = await import("./watch-view.js");
    await openWatch({ runsDir, dataDir, scenarios, runId: () => runId });
  },
};

const runIdCounts: Readonly<Record<keyof typeof commands, readonly [min: number, max: number]>> = {
  fetch: [0, 0],
  reproduce: [0, 0],
  evaluate: [0, 0],
  report: [1, Infinity],
  watch: [0, 1],
};

const usage = [
  "Usage: evorca",
  "       evorca <fetch|reproduce> --benchmark=<benchmark> [--scenario=<scenario>...]",
  "                [--archive=<path>...]",
  "       evorca evaluate --benchmark=<benchmark> --agent=<agent> [--scenario=<scenario>...]",
  "                [--runs=<count>] [--rows=[<scenario>:]<row>,...] [--jobs=<count>]",
  "                [--model=<model>] [--effort=<effort>] [--budget-usd=<dollars>]",
  "                [--task-budget-usd=<dollars>] [--plain]",
  "       evorca evaluate --benchmark=<benchmark> --resume=<run id> [--scenario=<scenario>...]",
  "                [--jobs=<count>] [--budget-usd=<dollars>] [--plain]",
  "       evorca report --benchmark=<benchmark> [--scenario=<scenario>...] <run id>...",
  "       evorca watch --benchmark=<benchmark> [--scenario=<scenario>...] [<run id>]",
].join("\n");

const { positionals, values } = parseCommandLine();
if (positionals.length === 0 && Object.keys(values).length === 0) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("evorca needs an interactive terminal.");
  const { openShell } = await import("./shell.js");
  const dirs = dirsOf("openrca");
  const upstreamUrl = readUpstreamUrl();
  await openShell({
    ...dirs,
    evaluate: (request) =>
      evaluateOpenRca({
        ...dirs,
        ...request,
        jobs: undefined,
        resume: undefined,
        apiKey,
        upstreamUrl,
      }),
  });
} else {
  const [command, ...ids] = positionals;
  if (!isKeyOf(commands, command)) fail(usage);
  const [min, max] = runIdCounts[command];
  if (ids.length < min || ids.length > max) fail(usage);
  const runIds = ids.map((id) => parseRunId(id, `evorca ${command}`));

  const name = choose(benchmarks, values.benchmark, "benchmark");
  const benchmark = benchmarks[name];

  const known = Object.keys(benchmark.scenarios);
  const scenarios = values.scenario ?? known;
  if (!scenarios.every((scenario) => isKeyOf(benchmark.scenarios, scenario))) {
    const unknown = scenarios.filter((scenario) => !isKeyOf(benchmark.scenarios, scenario));
    fail(`Unknown scenario: ${unknown.join(", ")}. Choose from: ${known.join(", ")}`);
  }

  await commands[command]({ benchmark, scenarios, runIds, flags: values, ...dirsOf(name) });
}

function dirsOf(benchmark: keyof typeof benchmarks) {
  const root = new URL("../../../", import.meta.url);
  return {
    dataDir: fileURLToPath(new URL(`data/benchmarks/${benchmark}/`, root)),
    cacheDir: fileURLToPath(new URL(".cache/", root)),
    runsDir: fileURLToPath(new URL(`data/runs/${benchmark}/`, root)),
    agentsDir: fileURLToPath(new URL("agents/", root)),
  };
}

async function printProgress(progress: AsyncIterable<FileProgress>) {
  try {
    for await (const { status, path, bytes, sha256 } of progress) {
      const hash = status === "fetching" ? "" : `  sha256 ${sha256}`;
      console.log(`${status}  ${relative(process.cwd(), path)}  ${bytes} bytes${hash}`);
    }
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

type Flags = {
  readonly archive?: readonly string[] | undefined;
  readonly agent?: string | undefined;
  readonly runs?: string | undefined;
  readonly rows?: readonly string[] | undefined;
  readonly jobs?: string | undefined;
  readonly resume?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly "budget-usd"?: string | undefined;
  readonly "task-budget-usd"?: string | undefined;
  readonly plain?: boolean | undefined;
};

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        benchmark: { type: "string" },
        scenario: { type: "string", multiple: true },
        agent: { type: "string" },
        archive: { type: "string", multiple: true },
        runs: { type: "string" },
        rows: { type: "string", multiple: true },
        jobs: { type: "string" },
        resume: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "budget-usd": { type: "string" },
        "task-budget-usd": { type: "string" },
        plain: { type: "boolean" },
      },
    });
  } catch (error: unknown) {
    return fail(`${error instanceof Error ? error.message : error}\n${usage}`);
  }
}

function readSeed(): number | undefined {
  const seed = process.env.EVORCA_SEED;
  if (seed === undefined) return undefined;
  if (!/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) {
    fail(`EVORCA_SEED must be a non-negative integer, not ${JSON.stringify(seed)}.`);
  }
  return Number(seed);
}

function parseCount(text: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(text))
    fail(`${flag} must be a positive integer, not ${JSON.stringify(text)}.`);
  return Number(text);
}

function parseUsd(text: string, flag: string): number {
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
    fail(`${flag} must be a positive number of US dollars, not ${JSON.stringify(text)}.`);
  }
  return Number(text);
}

function chooseEffort(text: string) {
  const effort = efforts.find((candidate) => candidate === text);
  if (effort === undefined) fail(`Unknown effort: ${text}. Choose from: ${efforts.join(", ")}`);
  return effort;
}

function readUpstreamUrl(): string {
  const url = process.env.EVORCA_UPSTREAM_URL ?? "https://api.anthropic.com";
  const parsed = URL.parse(url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed?.hostname ?? "");
  const secure = parsed?.protocol === "https:" || (parsed?.protocol === "http:" && loopback);
  if (!secure) {
    const allowed = "an https URL, or an http URL on localhost, 127.0.0.1, or [::1]";
    fail(`EVORCA_UPSTREAM_URL must be ${allowed}, not ${JSON.stringify(url)}.`);
  }
  return url;
}

function parseRunId(text: string, taker: string): string {
  if (!isRunId(text)) {
    fail(`${taker} takes a run ID, such as 20261117T121537Z-random, not ${JSON.stringify(text)}.`);
  }
  return text;
}

function choose<T extends object>(table: T, key: string | undefined, option: string) {
  if (isKeyOf(table, key)) return key;
  const problem = key === undefined ? `Missing --${option}` : `Unknown ${option}: ${key}`;
  return fail(`${problem}. Choose from: ${Object.keys(table).join(", ")}`);
}

function isKeyOf<T extends object>(table: T, key: string | undefined): key is keyof T & string {
  return key !== undefined && Object.hasOwn(table, key);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
