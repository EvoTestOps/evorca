/**
 * What `evorca watch` shows of a run: the board of its tasks, the facts for
 * its header, the task to show, and the feed of that task's trajectory. Every
 * function is pure. `watch-folder.ts` reads a {@link RunState} from the run
 * folder, and {@link applyLine} grows a {@link Feed} one trajectory line at a
 * time.
 *
 * @module
 */
import type { TaskIndex } from "@evorca/openrca";
import type { ScoredRow, Summary } from "@evorca/openrca/scoring";
import type { Outcome } from "./agents.js";
import { isRecord } from "./models.js";
import type { RunRecord, TaskRecord } from "./runs.js";

/** A task of the run that the board shows: its row, its kind, and its state. */
export type BoardTask = {
  readonly row: number;
  readonly taskIndex: TaskIndex | undefined;
  readonly state: TaskState;
};

/**
 * Where a task stands. A task is running from when its folder appears until
 * `run.json` records its outcome, and `costUsd` is what its model requests
 * have cost so far.
 */
export type TaskState =
  | { readonly kind: "pending" }
  | { readonly kind: "running"; readonly costUsd: number }
  | { readonly kind: "done"; readonly record: TaskRecord };

/**
 * What the folder of a run holds at one moment. `plan` lists the tasks of the
 * scenario, undefined when its data is missing. `running` gives the cost so
 * far of each task that has a folder but no record. `scores` is the content
 * of `scores.json`, undefined until the run is scored.
 */
export type RunState = {
  readonly folder: string;
  readonly record: RunRecord;
  readonly plan: readonly { readonly row: number; readonly taskIndex: TaskIndex }[] | undefined;
  readonly running: ReadonlyMap<number, number>;
  readonly scores: { readonly summary: Summary; readonly scores: readonly ScoredRow[] } | undefined;
};

/** Which task to show: the live task, or the task on a row that the user picked. */
export type Selection = { readonly kind: "live" } | { readonly kind: "task"; readonly row: number };

/** What a command or an answer got back: the text that the agent sees. */
export type ToolResult = {
  readonly output: string;
  readonly isError: boolean;
  readonly seconds: number;
};

/**
 * One entry of a task's feed, at the time in ms since the epoch when the agent
 * logged it. `task` is the instruction, `turn` a model response with its time
 * and cost, `think` a thinking summary, `say` the agent's text, `run` a shell
 * command, `answer` the submitted root causes, and `note` a message to the
 * agent or an API error. A `run` or `answer` has no result while it runs.
 */
export type FeedEntry =
  | { readonly kind: "task"; readonly at: number; readonly text: string }
  | {
      readonly kind: "turn";
      readonly at: number;
      readonly turn: number;
      readonly seconds: number;
      readonly costUsd: number;
    }
  | { readonly kind: "think" | "say" | "note"; readonly at: number; readonly text: string }
  | {
      readonly kind: "run" | "answer";
      readonly at: number;
      readonly id: string;
      readonly text: string;
      readonly result: ToolResult | undefined;
    };

/** The entries of a task's trajectory so far, in the order the agent logged them. */
export type Feed = readonly FeedEntry[];

/**
 * Returns the tasks of the run in row order. They are the rows the run covers,
 * or else every task of the plan, or else the tasks with a record or a folder.
 */
export function boardOf({ record, plan, running }: RunState): BoardTask[] {
  const records = new Map(record.tasks.map((task) => [task.row, task]));
  const kinds = new Map(plan?.map((task) => [task.row, task.taskIndex]));
  const rows = record.rows ??
    plan?.map((task) => task.row) ?? [...records.keys(), ...running.keys()];
  return [...new Set(rows)]
    .sort((a, b) => a - b)
    .map((row): BoardTask => {
      const done = records.get(row);
      const costUsd = running.get(row);
      const state: TaskState =
        done !== undefined
          ? { kind: "done", record: done }
          : costUsd !== undefined
            ? { kind: "running", costUsd }
            : { kind: "pending" };
      return { row, taskIndex: done?.taskIndex ?? kinds.get(row), state };
    });
}

/** What the run has spent so far in US dollars: its recorded usage and its running tasks. */
export function spentUsd({ record, running }: RunState): number {
  return (record.usage?.costUsd ?? 0) + [...running.values()].reduce((sum, cost) => sum + cost, 0);
}

/** How many tasks of `board` have each outcome, most common first. */
export function outcomeCounts(board: readonly BoardTask[]): [Outcome, number][] {
  const counts = new Map<Outcome, number>();
  for (const { state } of board) {
    if (state.kind === "done") {
      counts.set(state.record.outcome, (counts.get(state.record.outcome) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/**
 * Estimates the seconds until every task of `board` is done, from the mean
 * time of the tasks that ran and `jobs` tasks at a time. It is undefined
 * before a task finishes and once none is left.
 */
export function secondsLeft(board: readonly BoardTask[], jobs: number): number | undefined {
  const times = board.flatMap(({ state }) =>
    state.kind === "done" && state.record.seconds > 0 ? [state.record.seconds] : [],
  );
  const left = board.filter(({ state }) => state.kind !== "done").length;
  if (times.length === 0 || left === 0) return undefined;
  const mean = times.reduce((sum, seconds) => sum + seconds, 0) / times.length;
  return (left * mean) / Math.max(1, jobs);
}

/**
 * Returns the row to show for `selection`. The live task is the running task
 * on the lowest row, or else the done task on the highest row.
 */
export function selectedRow(board: readonly BoardTask[], selection: Selection): number | undefined {
  if (selection.kind === "task") return selection.row;
  const running = board.find(({ state }) => state.kind === "running");
  return running?.row ?? board.findLast(({ state }) => state.kind === "done")?.row;
}

/**
 * Returns the nearest row after `row` whose task has started, or before it when
 * `direction` is -1. It returns `row` at either end.
 */
export function nextRow(
  board: readonly BoardTask[],
  row: number | undefined,
  direction: 1 | -1,
): number | undefined {
  const rows = board.filter(({ state }) => state.kind !== "pending").map((task) => task.row);
  const next =
    direction === 1
      ? rows.find((candidate) => candidate > (row ?? -1))
      : rows.findLast((candidate) => candidate < (row ?? Infinity));
  return next ?? row;
}

/** Returns the row of the next running task after `row`, wrapping around, or `row` if none runs. */
export function nextRunning(
  board: readonly BoardTask[],
  row: number | undefined,
): number | undefined {
  const rows = board.filter(({ state }) => state.kind === "running").map((task) => task.row);
  return rows.find((candidate) => candidate > (row ?? -1)) ?? rows[0] ?? row;
}

/**
 * Returns `feed` with the trajectory line `line` applied. A line that is not
 * a JSON object, or an event that the feed does not show, leaves it as it is.
 */
export function applyLine(feed: Feed, line: string): Feed {
  const event = parseJson(line);
  if (!isRecord(event) || typeof event.type !== "string") return feed;
  const at = Date.parse(typeof event.at === "string" ? event.at : "");
  const apply = Object.hasOwn(events, event.type) ? events[event.type] : undefined;
  return apply?.(feed, event, at) ?? feed;
}

type Fields = Readonly<Record<string, unknown>>;

const events: Readonly<Record<string, (feed: Feed, event: Fields, at: number) => Feed>> = {
  task: (feed, { task }, at) =>
    isRecord(task) ? [...feed, { kind: "task", at, text: text(task.instruction) }] : feed,
  user: (feed, event, at) =>
    feed.some((entry) => entry.kind === "turn")
      ? [...feed, { kind: "note", at, text: text(event.text) }]
      : feed,
  "api-error": (feed, event, at) => [
    ...feed,
    { kind: "note", at, text: `API error ${text(event.status)}: ${text(event.message)}` },
  ],
  response: (feed, event, at) => {
    const message = isRecord(event.message) ? event.message : {};
    const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    const turn: FeedEntry = {
      kind: "turn",
      at,
      turn: number(event.turn),
      seconds: number(event.seconds),
      costUsd: number(event.costUsd),
    };
    return [...feed, turn, ...blocks.flatMap((block) => entriesOf(block, at))];
  },
  tool: (feed, event) => {
    const id = text(event.id);
    const result = {
      output: text(event.output),
      isError: event.isError === true,
      seconds: number(event.seconds),
    };
    const index = feed.findIndex((entry) => "id" in entry && entry.id === id);
    const entry = feed[index];
    return entry !== undefined && "id" in entry ? feed.with(index, { ...entry, result }) : feed;
  },
};

function entriesOf(block: Fields, at: number): FeedEntry[] {
  const input = isRecord(block.input) ? block.input : {};
  const id = text(block.id);
  if (block.type === "thinking" && text(block.thinking).trim() !== "") {
    return [{ kind: "think", at, text: text(block.thinking).trim() }];
  }
  if (block.type === "text" && text(block.text).trim() !== "") {
    return [{ kind: "say", at, text: text(block.text).trim() }];
  }
  if (block.type !== "tool_use") return [];
  if (block.name === "submit_answer") {
    const causes = Array.isArray(input.root_causes) ? input.root_causes.filter(isRecord) : [];
    const lines = causes.map((cause) =>
      [cause.occurrence_datetime, cause.component, cause.reason]
        .filter((field) => typeof field === "string")
        .join("  "),
    );
    return [
      { kind: "answer", at, id, text: lines.join("\n") || "no root cause", result: undefined },
    ];
  }
  const command = typeof input.command === "string" ? input.command.trimEnd() : "restart the shell";
  return [{ kind: "run", at, id, text: command, result: undefined }];
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === undefined ? "" : String(value);
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
