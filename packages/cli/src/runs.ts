/**
 * The record of an `evorca evaluate` run, `run.json`, and what a resumed run
 * needs from it. `evorca evaluate` rewrites `run.json` after every task, so a
 * run that stops can resume with the settings it started with.
 *
 * @module
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openRcaScenarios, type OpenRcaScenario, type TaskIndex } from "@evorca/openrca";
import type { pinnedInputs } from "@evorca/openrca/scoring";
import type { Agent, AgentName, Outcome } from "./agents.js";
import { isRecord, type Effort, type ModelId, type ModelUsage, type Prices } from "./models.js";

/**
 * What `run.json` records about one task. `exitCode` is null after a timeout,
 * when a signal ended the `docker run` client, or when the task never started.
 * `usage` is null unless the agent calls a model.
 */
export type TaskRecord = {
  readonly row: number;
  readonly taskIndex: TaskIndex;
  readonly outcome: Outcome;
  readonly exitCode: number | null;
  readonly seconds: number;
  readonly usage: ModelUsage | null;
};

/**
 * The model of a run: its API ID, its effort, the budget of each task, the API
 * that the proxy forwards to, and the prices behind each cost.
 */
export type ModelSettings = {
  readonly id: ModelId;
  readonly effort: Effort;
  readonly taskBudgetUsd: number;
  readonly upstreamUrl: string;
  readonly prices: {
    readonly table: string;
    readonly source: string;
    readonly checkedAt: string;
    readonly usdPerMTok: Prices;
  };
};

/** The agent of a run: its entry in the agents table, its name, and its image. */
export type AgentRecord = Omit<Agent, "jobs"> & {
  readonly name: AgentName;
  readonly image: string;
  readonly imageId: string;
};

/** The git commit of a session of a run, and whether the checkout had uncommitted changes. */
export type GitState = { readonly commit: string; readonly dirty: boolean };

/**
 * A run's place in a series of runs with the same settings: run `run` of
 * `runs`. Run `k` of series `id` has the run ID `<id>-<k>` and the seed of run
 * 1 plus `k - 1`.
 */
export type Series = { readonly id: string; readonly run: number; readonly runs: number };

/** The Node version and the Docker versions of a session of a run. */
export type Versions = {
  readonly node: string;
  readonly docker: { readonly client: string; readonly server: string };
};

/**
 * What `run.json` records about the run of one agent on one scenario. `series`
 * is missing unless the run is one of several that `--runs` started. `rows` is
 * null when the run covers every task. `model` and `budgetUsd`, the model budget
 * of the whole run over all its scenarios, are null unless the agent calls a
 * model. `jobs` and `budgetUsd` hold the values of the latest session.
 * `resumes` lists each later session of the run, and `endedAt` is null until
 * the run is scored. `abandoned` holds what each task that a resume ran again
 * had spent before. `usage` adds up the usage of the tasks and of `abandoned`.
 */
export type RunRecord = {
  readonly runId: string;
  readonly benchmark: "openrca";
  readonly scenario: OpenRcaScenario;
  readonly series?: Series;
  readonly agent: AgentRecord;
  readonly seed: number;
  readonly rows: readonly number[] | null;
  readonly model: ModelSettings | null;
  readonly budgetUsd: number | null;
  readonly jobs: number;
  readonly git: GitState;
  readonly pinnedInputs: typeof pinnedInputs;
  readonly versions: Versions;
  readonly startedAt: string;
  readonly resumes: readonly {
    readonly startedAt: string;
    readonly git: GitState;
    readonly versions: Versions;
  }[];
  readonly endedAt: string | null;
  readonly tasks: readonly TaskRecord[];
  readonly abandoned: readonly { readonly row: number; readonly usage: ModelUsage }[];
  readonly usage: ModelUsage | null;
};

/** Every OpenRCA scenario, in the order of `openRcaScenarios`. */
export const allScenarios = Object.keys(openRcaScenarios).filter(
  (scenario): scenario is OpenRcaScenario => Object.hasOwn(openRcaScenarios, scenario),
);

/** Whether `text` has the form of a run ID, such as `20261117T121537Z-random`. */
export function isRunId(text: string): boolean {
  return /^\d{8}T\d{6}Z-[a-z0-9-]+$/.test(text);
}

/** The folder of the task on row `row` in the folder of a run. */
export function taskDirOf(runDir: string, row: number): string {
  return join(runDir, "tasks", String(row).padStart(3, "0"));
}

/**
 * The rows that a run covers in each scenario that it does not cover whole,
 * counted from 0 in the scenario's `query.csv`.
 */
export type Rows = ReadonlyMap<OpenRcaScenario, readonly number[]>;

/**
 * Parses the values of `--rows` for a run of `scenarios`. A value such as
 * `0,7,21` gives rows of each scenario that no other value names, and a value
 * such as `telecom:0,7,21` gives rows of one scenario. The values for one
 * scenario add up, and so do the values without a scenario. It returns each
 * scenario's rows in order, or the problem if a value has another form, names
 * a scenario outside `scenarios`, or gives a row that is already given.
 */
export function parseRows(
  values: readonly string[],
  scenarios: readonly OpenRcaScenario[],
): Rows | string {
  const named = new Map<OpenRcaScenario, Set<number>>();
  const others = new Set<number>();
  for (const value of values) {
    const [, name, list] = /^(?:([a-z0-9-]+):)?(\d+(?:,\d+)*)$/.exec(value) ?? [];
    if (list === undefined) {
      const forms = "--rows=0,7,21 or --rows=telecom:0,7,21";
      return `--rows must list row numbers, such as ${forms}, not ${JSON.stringify(value)}.`;
    }
    const scenario = scenarios.find((candidate) => candidate === name);
    if (name !== undefined && scenario === undefined) {
      return `--rows=${value} names ${name}, but the run covers ${scenarios.join(", ")}.`;
    }
    const rows = scenario === undefined ? others : (named.get(scenario) ?? new Set());
    if (scenario !== undefined) named.set(scenario, rows);
    for (const row of list.split(",").map(Number)) {
      if (rows.has(row)) {
        return `--rows gives row ${row}${scenario === undefined ? "" : ` of ${scenario}`} twice.`;
      }
      rows.add(row);
    }
  }
  return new Map(
    scenarios.flatMap((scenario) => {
      const rows = named.get(scenario) ?? others;
      return rows.size === 0 ? [] : [[scenario, [...rows].sort((a, b) => a - b)] as const];
    }),
  );
}

/** The settings of a run that its results depend on. A resumed run keeps each of them. */
export type Conditions = Pick<RunRecord, "agent" | "seed" | "rows" | "model">;

const conditionKeys = [
  "agent",
  "seed",
  "rows",
  "model",
] as const satisfies readonly (keyof Conditions)[];

/**
 * Returns one line for each setting in `requested` that differs from the one
 * in `recorded`, such as a setting that a resumed run asks for. A line names
 * the field that differs, such as `model.effort`, and says "the run has" the
 * value in `recorded`. An undefined setting in `requested` matches any.
 */
export function conflicts(recorded: Conditions, requested: Partial<Conditions>): string[] {
  return conditionKeys.flatMap((key) =>
    requested[key] === undefined ? [] : differences(key, recorded[key], requested[key]),
  );
}

function differences(path: string, recorded: unknown, requested: unknown): string[] {
  if (isDeepStrictEqual(requested, recorded)) return [];
  if (isRecord(recorded) && isRecord(requested)) {
    const keys = new Set([...Object.keys(recorded), ...Object.keys(requested)]);
    return [...keys].flatMap((key) => differences(`${path}.${key}`, recorded[key], requested[key]));
  }
  return [`${path}: the run has ${JSON.stringify(recorded)}, not ${JSON.stringify(requested)}`];
}

const rerunOutcomes: ReadonlySet<Outcome> = new Set(["budget-exhausted", "stopped"]);

/**
 * Returns the tasks of `tasks` that have no outcome in `records`, or the
 * outcome `budget-exhausted` or `stopped`, in the order of `tasks`.
 */
export function tasksToRun<T extends { readonly row: number }>(
  tasks: readonly T[],
  records: readonly TaskRecord[],
): T[] {
  const done = new Set(
    records.filter((record) => !rerunOutcomes.has(record.outcome)).map((record) => record.row),
  );
  return tasks.filter((task) => !done.has(task.row));
}

/** Whether a run is scored and none of its tasks would run again on a resume. */
export function isFinished(record: RunRecord): record is RunRecord & { readonly endedAt: string } {
  return record.endedAt !== null && !record.tasks.some((task) => rerunOutcomes.has(task.outcome));
}

/**
 * Calls `work` on each item, at most `jobs` at a time, and starts the items in
 * order. Once `signal` aborts or a call throws, it starts no more items. It
 * waits for the calls in flight, then throws the first error.
 */
export async function runPool<T>(
  items: readonly T[],
  jobs: number,
  work: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  // The workers share one iterator, so each item goes to exactly one worker.
  const queue = items.values();
  let failure: { readonly error: unknown } | undefined;
  const worker = async () => {
    for (const item of queue) {
      if (failure !== undefined || signal?.aborted) return;
      await work(item).catch((error: unknown) => {
        failure ??= { error };
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

/**
 * Writes `value` to `path` as indented JSON. It writes a staging file and
 * renames it into place, so a reader or a crash never sees half a file. Calls
 * for the same path must not overlap.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const staging = `${path}.tmp`;
  await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`);
  await rename(staging, path);
}

/**
 * Reads the `run.json` of run `runId` in the folder of each of `scenarios` that
 * has one, and returns them by scenario.
 *
 * @throws Error if a `run.json` exists but cannot be read or parsed.
 */
export async function readRuns(
  runsDir: string,
  runId: string,
  scenarios: readonly OpenRcaScenario[],
): Promise<Map<OpenRcaScenario, RunRecord>> {
  const runs = new Map<OpenRcaScenario, RunRecord>();
  for (const scenario of scenarios) {
    const text = await readFile(join(runsDir, scenario, runId, "run.json"), "utf8").catch(
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (text !== undefined) runs.set(scenario, JSON.parse(text));
  }
  return runs;
}
