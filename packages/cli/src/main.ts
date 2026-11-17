/**
 * The `evorca` command, which `pnpm evorca` runs from the repository root.
 * `evorca fetch` downloads the data of a benchmark's scenarios into
 * `data/benchmarks/<benchmark>/<scenario>/` at the repository root.
 * `evorca reproduce` checks that evorca reproduces the scores that the
 * benchmark publishes, and keeps the scorer's checkout and environment in
 * `.cache/` at the repository root.
 *
 * @module
 */
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openRcaScenarios } from "@evorca/openrca";
import { fetchOpenRcaData } from "@evorca/openrca/dataset";
import { reproduceOpenRca } from "./openrca.js";

const benchmarks = {
  openrca: { scenarios: openRcaScenarios, fetch: fetchOpenRcaData, reproduce: reproduceOpenRca },
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
    for (const file of await benchmark.fetch({ scenarios, dataDir })) {
      const status = file.fetched ? "fetched" : "present";
      const path = relative(process.cwd(), file.path);
      console.log(`${status}  ${path}  ${file.bytes} bytes  sha256 ${file.sha256}`);
    }
  },
  async reproduce({ benchmark, scenarios, dataDir, cacheDir }: Invocation) {
    if (!(await benchmark.reproduce({ scenarios, dataDir, cacheDir }))) process.exitCode = 1;
  },
};

const usage = `Usage: evorca <${Object.keys(commands).join("|")}> --benchmark=<benchmark> [--scenario=<scenario>...]`;

const { positionals, values } = parseCommandLine();
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
