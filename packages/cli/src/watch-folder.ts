/**
 * Reads the folders of `evorca evaluate` runs while they grow, for `evorca
 * watch`. It never writes. Each read picks the run to show, reads its
 * `run.json`, finds the running tasks by their folders, and reads what the
 * growing files gained since the last read: the `requests.jsonl` of each
 * running task and the `trajectory.jsonl` of the task on screen. It keeps a
 * line that is still being written for the next read, and a missing file or
 * folder reads as empty until it appears.
 *
 * @module
 */
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readTasks, type OpenRcaScenario } from "@evorca/openrca";
import { usageOfLog } from "./models.js";
import { isRunId, readRuns, taskDirOf, type RunRecord } from "./runs.js";
import {
  applyLine,
  boardOf,
  selectedRow,
  type BoardTask,
  type Feed,
  type RunState,
  type Selection,
} from "./watch.js";

/**
 * What one read finds: the run with its board, the row on screen, and the feed
 * of that row's trajectory, or a message while there is no run to show.
 */
export type Frame =
  | { readonly kind: "waiting"; readonly message: string }
  | {
      readonly kind: "run";
      readonly state: RunState;
      readonly board: readonly BoardTask[];
      readonly row: number | undefined;
      readonly feed: Feed;
    };

/**
 * Where the runs are, and which to show. `runId` returns the ID of the run to
 * show, or undefined to follow the newest run in the folders of `scenarios`.
 * When a run covers several scenarios, the reader shows the one with running
 * tasks, else the first that is not scored yet, or else the last.
 */
export type RunFolders = {
  readonly runsDir: string;
  readonly dataDir: string;
  readonly scenarios: readonly OpenRcaScenario[];
  readonly runId: () => string | undefined;
};

/**
 * Returns a function that reads the run and the trajectory of the task that a
 * selection picks. Calls run one after another, never at the same time.
 */
export function readRunFolders(folders: RunFolders): (selection: Selection) => Promise<Frame> {
  const plans = new Map<OpenRcaScenario, Promise<RunState["plan"]>>();
  let folder: string | undefined;
  let costs = new Map<number, { readonly tail: LineTail; readonly costUsd: number }>();
  let trajectory: { readonly row: number; readonly tail: LineTail; feed: Feed } | undefined;

  async function read(selection: Selection): Promise<Frame> {
    const run = await locate(folders);
    if (run === undefined) {
      const which = folders.runId() ?? "yet";
      return { kind: "waiting", message: `No run ${which} in ${folders.runsDir}` };
    }
    if (run.folder !== folder) {
      folder = run.folder;
      costs = new Map();
      trajectory = undefined;
    }
    const prices = run.record.model?.prices.usdPerMTok;
    const next = new Map<number, { readonly tail: LineTail; readonly costUsd: number }>();
    for (const row of run.running) {
      const known = costs.get(row);
      const tail = known?.tail ?? new LineTail(join(taskDirOf(run.folder, row), "requests.jsonl"));
      const { restarted, lines } = await tail.read();
      const added = prices === undefined ? 0 : usageOfLog(lines.join("\n"), prices).costUsd;
      next.set(row, { tail, costUsd: (restarted ? 0 : (known?.costUsd ?? 0)) + added });
    }
    costs = next;

    if (!plans.has(run.scenario)) {
      const plan = readTasks(run.scenario, folders.dataDir).then(
        (tasks) => tasks.map(({ row, taskIndex }) => ({ row, taskIndex })),
        () => undefined,
      );
      plans.set(run.scenario, plan);
    }
    const state: RunState = {
      folder: run.folder,
      record: run.record,
      plan: await plans.get(run.scenario),
      running: new Map([...costs].map(([row, { costUsd }]) => [row, costUsd])),
      scores: run.record.endedAt === null ? undefined : await readScores(run.folder),
    };
    const board = boardOf(state);
    const row = selectedRow(board, selection);
    if (row === undefined) return { kind: "run", state, board, row, feed: [] };
    if (trajectory?.row !== row) {
      const path = join(taskDirOf(run.folder, row), "out", "trajectory.jsonl");
      trajectory = { row, tail: new LineTail(path), feed: [] };
    }
    const { restarted, lines } = await trajectory.tail.read();
    trajectory.feed = lines.reduce(applyLine, restarted ? [] : trajectory.feed);
    return { kind: "run", state, board, row, feed: trajectory.feed };
  }

  let queue: Promise<unknown> = Promise.resolve();
  return (selection) => {
    const frame = queue.then(() => read(selection));
    queue = frame.catch(() => {});
    return frame;
  };
}

class LineTail {
  #offset = 0;
  #inode: number | undefined;
  #partial = Buffer.alloc(0);

  constructor(readonly path: string) {}

  async read(): Promise<{ readonly restarted: boolean; readonly lines: readonly string[] }> {
    const handle = await open(this.path, "r").catch(ifMissing(undefined));
    if (handle === undefined) {
      const restarted = this.#inode !== undefined;
      this.#offset = 0;
      this.#inode = undefined;
      this.#partial = Buffer.alloc(0);
      return { restarted, lines: [] };
    }
    try {
      const { size, ino } = await handle.stat();
      const restarted = (this.#inode !== undefined && ino !== this.#inode) || size < this.#offset;
      this.#inode = ino;
      if (restarted) {
        this.#offset = 0;
        this.#partial = Buffer.alloc(0);
      }
      const chunk = Buffer.alloc(size - this.#offset);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.#offset);
      this.#offset += bytesRead;
      const bytes = Buffer.concat([this.#partial, chunk.subarray(0, bytesRead)]);
      const end = bytes.lastIndexOf(0x0a);
      this.#partial = bytes.subarray(end + 1);
      const lines = end === -1 ? [] : bytes.subarray(0, end).toString("utf8").split("\n");
      return { restarted, lines };
    } finally {
      await handle.close();
    }
  }
}

async function locate({ runsDir, scenarios, runId }: RunFolders) {
  const id = runId() ?? (await newestRunId(runsDir, scenarios));
  if (id === undefined) return undefined;
  const records = await readRuns(runsDir, id, scenarios);
  const runs = await Array.fromAsync(records, async ([scenario, record]) => {
    const folder = join(runsDir, scenario, id);
    const recorded = new Set(record.tasks.map((task) => task.row));
    const running = (await taskRows(folder)).filter((row) => !recorded.has(row));
    return { scenario, record, folder, running };
  });
  const unscored = runs.filter(({ record }) => record.endedAt === null);
  return unscored.find(({ running }) => running.length > 0) ?? unscored[0] ?? runs.at(-1);
}

async function newestRunId(
  runsDir: string,
  scenarios: readonly OpenRcaScenario[],
): Promise<string | undefined> {
  const ids = await Array.fromAsync(scenarios, (scenario) =>
    readdir(join(runsDir, scenario)).catch(ifMissing([])),
  );
  return ids
    .flat()
    .filter(isRunId)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .at(-1);
}

async function taskRows(folder: string): Promise<number[]> {
  const names = await readdir(join(folder, "tasks")).catch(ifMissing([]));
  return names.filter((name) => /^\d{3,}$/.test(name)).map(Number);
}

async function readScores(folder: string): Promise<RunState["scores"]> {
  const text = await readFile(join(folder, "scores.json"), "utf8").catch(ifMissing(undefined));
  return text === undefined ? undefined : JSON.parse(text);
}

function ifMissing<T>(value: T): (error: unknown) => T {
  return (error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return value;
    throw error;
  };
}
