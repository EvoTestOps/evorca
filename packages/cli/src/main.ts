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
 *
 * @module
 */
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openRcaScenarios } from "@evorca/openrca";
import { answerKeyFiles, fetchOpenRcaData, type FileProgress } from "@evorca/openrca/dataset";
import { reproduceOpenRca } from "./openrca.js";

const benchmarks = {
  openrca: {
    scenarios: openRcaScenarios,
    answerKeys: answerKeyFiles,
    fetch: fetchOpenRcaData,
    reproduce: reproduceOpenRca,
  },
};

type Benchmark = (typeof benchmarks)[keyof typeof benchmarks];

type Invocation = {
  readonly benchmark: Benchmark;
  readonly scenarios: readonly (keyof Benchmark["scenarios"])[];
  readonly dataDir: string;
  readonly cacheDir: string;
};

const commands = {
  async fetch({ benchmark, scenarios, dataDir }: Invocation) {
    await printProgress(benchmark.fetch({ scenarios, dataDir }));
  },
  async reproduce({ benchmark, scenarios, dataDir, cacheDir }: Invocation) {
    await printProgress(benchmark.fetch({ scenarios, dataDir, files: benchmark.answerKeys }));
    if (!(await benchmark.reproduce({ scenarios, dataDir, cacheDir }))) process.exitCode = 1;
  },
};

const usage = [
  "Usage: evorca",
  `       evorca <${Object.keys(commands).join("|")}> --benchmark=<benchmark> [--scenario=<scenario>...]`,
].join("\n");

const { positionals, values } = parseCommandLine();
if (positionals.length === 0 && Object.keys(values).length === 0) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("evorca needs an interactive terminal.");
  const { openShell } = await import("./shell.js");
  await openShell();
} else {
  const [command] = positionals;
  if (positionals.length !== 1 || !isKeyOf(commands, command)) fail(usage);

  const name = values.benchmark;
  if (!isKeyOf(benchmarks, name)) {
    const problem = name === undefined ? "Missing --benchmark" : `Unknown benchmark: ${name}`;
    fail(`${problem}. Choose from: ${Object.keys(benchmarks).join(", ")}`);
  }
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
    dataDir: fileURLToPath(new URL(`data/benchmarks/${name}/`, root)),
    cacheDir: fileURLToPath(new URL(".cache/", root)),
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
      },
    });
  } catch (error: unknown) {
    return fail(`${error instanceof Error ? error.message : error}\n${usage}`);
  }
}

function isKeyOf<T extends object>(table: T, key: string | undefined): key is keyof T & string {
  return key !== undefined && Object.hasOwn(table, key);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
