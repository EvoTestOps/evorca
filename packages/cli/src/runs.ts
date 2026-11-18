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
import type { OpenRcaScenario, TaskIndex } from "@evorca/openrca";
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

/** The Node version and the Docker versions of a session of a run. */
export type Versions = {
  readonly node: string;
  readonly docker: { readonly client: string; readonly server: string };
};

/**
 * What `run.json` records about the run of one agent on one scenario. `rows` is
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

/** The settings of a run that its results depend on. A resumed run keeps each of them. */
export type Conditions = Pick<RunRecord, "agent" | "seed" | "rows" | "model">;

const conditionKeys = [
  "agent",
  "seed",
  "rows",
  "model",
] as const satisfies readonly (keyof Conditions)[];

/**
 * Returns one line for each setting that a resumed run asks for and that
 * differs from the run's own. A line names the field that differs, such as
 * `model.effort`. An undefined setting keeps the run's.
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
