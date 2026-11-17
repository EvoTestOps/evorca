/**
 * The `evorca` command, which `pnpm evorca` runs from the repository root.
 * Without arguments, `evorca` opens the interactive shell full screen, and
 * exits with code 1 when stdin or stdout is not a terminal. It loads the shell
 * on demand, so the other commands never load OpenTUI's native library.
 * `evorca fetch` downloads the data of a benchmark's scenarios, the answer keys
 * and the telemetry, into `data/benchmarks/<benchmark>/<scenario>/` at the
 * repository root.
 * `evorca reproduce` downloads only the answer keys of those scenarios, checks
 * that evorca reproduces the scores that the benchmark publishes, and keeps the
 * scorer's checkout and environment in `.cache/` at the repository root.
 * `evorca evaluate` runs an agent from `agents/` on those scenarios, one Docker
 * container per task, scores its answers, and keeps each run in
 * `data/runs/<benchmark>/<scenario>/`.
 *
 * The command takes the real API key from `ANTHROPIC_API_KEY` and then deletes
 * the variable, so no child process inherits the key. `pnpm evorca` loads the
 * variable from `.env` at the repository root if the file exists.
 * `EVORCA_UPSTREAM_URL` replaces the Anthropic API for the model proxy, such as
 * with a mock in a test.
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

const apiKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const benchmarks = {
  openrca: {
    scenarios: openRcaScenarios,
    answerKeys: answerKeyFiles,
    fetch: fetchOpenRcaData,
    reproduce: reproduceOpenRca,
    evaluate: evaluateOpenRca,
  },
};

type Benchmark = (typeof benchmarks)[keyof typeof benchmarks];

type Invocation = {
  readonly benchmark: Benchmark;
  readonly scenarios: readonly (keyof Benchmark["scenarios"])[];
  readonly flags: Flags;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly runsDir: string;
  readonly agentsDir: string;
};

const commands = {
  async fetch({ benchmark, scenarios, dataDir }: Invocation) {
    await printProgress(benchmark.fetch({ scenarios, dataDir }));
  },
  async reproduce({ benchmark, scenarios, dataDir, cacheDir }: Invocation) {
    await printProgress(benchmark.fetch({ scenarios, dataDir, files: benchmark.answerKeys }));
    if (!(await benchmark.reproduce({ scenarios, dataDir, cacheDir }))) process.exitCode = 1;
  },
  async evaluate({ benchmark, scenarios, flags, ...dirs }: Invocation) {
    const resume = flags.resume === undefined ? undefined : parseRunId(flags.resume);
    const agent =
      flags.agent === undefined && resume !== undefined
        ? undefined
        : choose(agents, flags.agent, "agent");
    const options = {
      ...dirs,
      scenarios,
      agent,
      resume,
      seed: readSeed(),
      rows: flags.rows === undefined ? undefined : parseRows(flags.rows),
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
    if (!(await benchmark.evaluate(options))) process.exitCode = 1;
  },
};

const usage = [
  "Usage: evorca",
  `       evorca <${Object.keys(commands).join("|")}> --benchmark=<benchmark> [--scenario=<scenario>...]`,
  "       evorca evaluate --benchmark=<benchmark> --agent=<agent> [--scenario=<scenario>...]",
  "                [--rows=<row>,...] [--jobs=<count>] [--model=<model>] [--effort=<effort>]",
  "                [--budget-usd=<dollars>] [--task-budget-usd=<dollars>]",
  "       evorca evaluate --benchmark=<benchmark> --resume=<run id> [--scenario=<scenario>...]",
  "                [--jobs=<count>] [--budget-usd=<dollars>]",
].join("\n");

const { positionals, values } = parseCommandLine();
if (positionals.length === 0 && Object.keys(values).length === 0) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("evorca needs an interactive terminal.");
  const { openShell } = await import("./shell.js");
  await openShell();
} else {
  const [command] = positionals;
  if (positionals.length !== 1 || !isKeyOf(commands, command)) fail(usage);

  const name = choose(benchmarks, values.benchmark, "benchmark");
  const benchmark = benchmarks[name];

  const known = Object.keys(benchmark.scenarios);
  const scenarios = values.scenario ?? known;
  if (!scenarios.every((scenario) => isKeyOf(benchmark.scenarios, scenario))) {
    const unknown = scenarios.filter((scenario) => !isKeyOf(benchmark.scenarios, scenario));
    fail(`Unknown scenario: ${unknown.join(", ")}. Choose from: ${known.join(", ")}`);
  }

  const root = new URL("../../../", import.meta.url);
  await commands[command]({
    benchmark,
    scenarios,
    flags: values,
    dataDir: fileURLToPath(new URL(`data/benchmarks/${name}/`, root)),
    cacheDir: fileURLToPath(new URL(".cache/", root)),
    runsDir: fileURLToPath(new URL(`data/runs/${name}/`, root)),
    agentsDir: fileURLToPath(new URL("agents/", root)),
  });
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
  readonly agent?: string | undefined;
  readonly rows?: string | undefined;
  readonly jobs?: string | undefined;
  readonly resume?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly "budget-usd"?: string | undefined;
  readonly "task-budget-usd"?: string | undefined;
};

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        benchmark: { type: "string" },
        scenario: { type: "string", multiple: true },
        agent: { type: "string" },
        rows: { type: "string" },
        jobs: { type: "string" },
        resume: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "budget-usd": { type: "string" },
        "task-budget-usd": { type: "string" },
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

function parseRows(text: string): number[] {
  if (!/^\d+(,\d+)*$/.test(text)) {
    fail(`--rows must list row numbers, such as --rows=0,7,21, not ${JSON.stringify(text)}.`);
  }
  return [...new Set(text.split(",").map(Number))].sort((a, b) => a - b);
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
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    fail(`EVORCA_UPSTREAM_URL must be an http or https URL, not ${JSON.stringify(url)}.`);
  }
  return url;
}

function parseRunId(text: string): string {
  if (!/^\d{8}T\d{6}Z-[a-z0-9-]+$/.test(text)) {
    fail(`--resume takes a run ID, such as 20261117T121537Z-random, not ${JSON.stringify(text)}.`);
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
