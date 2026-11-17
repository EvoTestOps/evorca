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
 * Both read the files of each dataset archive given as `--archive=<path>` from
 * that copy on disk instead of downloading them.
 * `evorca evaluate` runs an agent from `agents/` on those scenarios, one Docker
 * container per task, scores its answers, and keeps each run in
 * `data/runs/<benchmark>/<scenario>/`.
 *
 * @module
 */
import { randomInt } from "node:crypto";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openRcaScenarios } from "@evorca/openrca";
import { answerKeyFiles, fetchOpenRcaData, type FileProgress } from "@evorca/openrca/dataset";
import { agents } from "./agents.js";
import { evaluateOpenRca, reproduceOpenRca } from "./openrca.js";

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
  readonly agent: string | undefined;
  readonly archives: readonly string[];
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly runsDir: string;
  readonly agentsDir: string;
};

const commands = {
  async fetch({ benchmark, scenarios, archives, dataDir }: Invocation) {
    await printProgress(benchmark.fetch({ scenarios, dataDir, localArchives: archives }));
  },
  async reproduce({ benchmark, scenarios, archives, dataDir, cacheDir }: Invocation) {
    const files = benchmark.answerKeys;
    await printProgress(benchmark.fetch({ scenarios, dataDir, files, localArchives: archives }));
    if (!(await benchmark.reproduce({ scenarios, dataDir, cacheDir }))) process.exitCode = 1;
  },
  async evaluate({ benchmark, scenarios, agent, ...dirs }: Invocation) {
    const options = { ...dirs, scenarios, agent: choose(agents, agent, "agent"), seed: readSeed() };
    if (!(await benchmark.evaluate(options))) process.exitCode = 1;
  },
};

const usage = [
  "Usage: evorca",
  `       evorca <${Object.keys(commands).join("|")}> --benchmark=<benchmark> [--scenario=<scenario>...]`,
  "                [--agent=<agent>] [--archive=<path>...]",
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
    agent: values.agent,
    archives: values.archive ?? [],
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

function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        benchmark: { type: "string" },
        scenario: { type: "string", multiple: true },
        agent: { type: "string" },
        archive: { type: "string", multiple: true },
      },
    });
  } catch (error: unknown) {
    return fail(`${error instanceof Error ? error.message : error}\n${usage}`);
  }
}

function readSeed(): number {
  const seed = process.env.EVORCA_SEED;
  if (seed === undefined) return randomInt(2 ** 32);
  if (!/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) {
    fail(`EVORCA_SEED must be a non-negative integer, not ${JSON.stringify(seed)}.`);
  }
  return Number(seed);
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
