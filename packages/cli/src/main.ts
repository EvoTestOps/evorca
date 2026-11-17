/**
 * The `evorca` command, which `pnpm evorca` runs from the repository root.
 * `evorca fetch` downloads the data of a benchmark's scenarios into
 * `data/benchmarks/<benchmark>/<scenario>/` at the repository root.
 *
 * @module
 */
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openRcaScenarios } from "@evorca/openrca";
import { fetchOpenRcaData } from "@evorca/openrca/dataset";

const benchmarks = {
  openrca: { scenarios: openRcaScenarios, fetch: fetchOpenRcaData },
};

const usage = "Usage: evorca fetch --benchmark=<benchmark> [--scenario=<scenario>...]";

const { positionals, values } = parseCommandLine();
if (positionals.length !== 1 || positionals[0] !== "fetch") fail(usage);

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

const dataDir = fileURLToPath(new URL(`../../../data/benchmarks/${name}/`, import.meta.url));
for (const file of await benchmark.fetch({ scenarios, dataDir })) {
  const status = file.fetched ? "fetched" : "present";
  const path = relative(process.cwd(), file.path);
  console.log(`${status}  ${path}  ${file.bytes} bytes  sha256 ${file.sha256}`);
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
