/**
 * The record of an `evorca evaluate` run, `run.json`, and what a resumed run
 * needs from it. `evorca evaluate` rewrites `run.json` after every task, so a
 * run that stops can resume from its last finished task with the settings it
 * started with.
 *
 * @module
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenRcaScenario, TaskIndex } from "@evorca/openrca";
import type { pinnedInputs } from "@evorca/openrca/scoring";
import type { Agent, AgentName, Outcome } from "./agents.js";

/**
 * What `run.json` records about one task. `exitCode` is null after a timeout or
 * when a signal ended the `docker run` client.
 */
export type TaskRecord = {
  readonly row: number;
  readonly taskIndex: TaskIndex;
  readonly outcome: Outcome;
  readonly exitCode: number | null;
  readonly seconds: number;
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
 * null when the run covers every task. `jobs` is how many tasks ran at once in
 * the latest session. `resumes` lists each later session of the run, and
 * `endedAt` is null until every task has an outcome.
 */
export type RunRecord = {
  readonly runId: string;
  readonly benchmark: "openrca";
  readonly scenario: OpenRcaScenario;
  readonly agent: AgentRecord;
  readonly seed: number;
  readonly rows: readonly number[] | null;
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
};

/** The settings of a run that its results depend on. A resumed run keeps each of them. */
export type Conditions = Pick<RunRecord, "agent" | "seed" | "rows">;

const conditionKeys = ["agent", "seed", "rows"] as const satisfies readonly (keyof Conditions)[];

/**
 * Returns one line for each setting that a resumed run asks for and that
 * differs from the run's own. An undefined setting keeps the run's.
 */
export function conflicts(recorded: Conditions, requested: Partial<Conditions>): string[] {
  return conditionKeys.flatMap((key) => {
    const value = requested[key];
    if (value === undefined || isDeepStrictEqual(value, recorded[key])) return [];
    return [`${key}: the run has ${JSON.stringify(recorded[key])}, not ${JSON.stringify(value)}`];
  });
}

/** Returns the tasks of `tasks` that have no outcome in `records`, in the order of `tasks`. */
export function tasksToRun<T extends { readonly row: number }>(
  tasks: readonly T[],
  records: readonly TaskRecord[],
): T[] {
  const done = new Set(records.map((record) => record.row));
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
