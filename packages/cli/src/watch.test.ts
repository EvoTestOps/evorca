import { describe, expect, it } from "vitest";
import { noUsage } from "./models.js";
import type { TaskRecord } from "./runs.js";
import {
  applyLine,
  boardOf,
  nextRow,
  nextRunning,
  outcomeCounts,
  secondsLeft,
  selectedRow,
  spentUsd,
  type Feed,
  type RunState,
} from "./watch.js";
import { bash, event, response, runRecord, taskEvent, taskRecord, tool } from "./watch-fixtures.js";

const answer = {
  type: "tool_use",
  id: "toolu_2",
  name: "submit_answer",
  input: {
    root_causes: [
      { occurrence_datetime: "2020-04-11 00:08:06", component: "docker_003", reason: "CPU fault" },
    ],
  },
};

const trajectory = [
  taskEvent("40:00", "Find the root cause reason."),
  event("user", "40:00", {
    text: "The issue you are going to solve is: Find the root cause reason.",
  }),
  response("40:03", 1, [
    { type: "thinking", thinking: "Start with the node metrics.", signature: "x" },
    { type: "text", text: "Listing the metric files." },
    bash("toolu_1", "ls /data/metric"),
  ]),
  tool("40:04", "toolu_1", "metric_node.csv\nmetric_service.csv\n"),
  event("user", "40:05", { text: "Call submit_answer now." }),
  response("40:08", 2, [answer]),
  tool("40:08", "toolu_2", "Accepted."),
];

function feedOf(lines: readonly string[]): Feed {
  return lines.map((line) => line.trimEnd()).reduce(applyLine, []);
}

function at(time: string): number {
  return Date.parse(`2026-11-18T09:${time}.000Z`);
}

describe("applyLine", () => {
  it("shows the instruction, each turn, the thinking, the text, the commands with their output, and the answer", () => {
    expect(feedOf(trajectory)).toEqual([
      { kind: "task", at: at("40:00"), text: "Find the root cause reason." },
      { kind: "turn", at: at("40:03"), turn: 1, seconds: 2.5, costUsd: 0.0125 },
      { kind: "think", at: at("40:03"), text: "Start with the node metrics." },
      { kind: "say", at: at("40:03"), text: "Listing the metric files." },
      {
        kind: "run",
        at: at("40:03"),
        id: "toolu_1",
        text: "ls /data/metric",
        result: { output: "metric_node.csv\nmetric_service.csv\n", isError: false, seconds: 0.5 },
      },
      { kind: "note", at: at("40:05"), text: "Call submit_answer now." },
      { kind: "turn", at: at("40:08"), turn: 2, seconds: 2.5, costUsd: 0.0125 },
      {
        kind: "answer",
        at: at("40:08"),
        id: "toolu_2",
        text: "2020-04-11 00:08:06  docker_003  CPU fault",
        result: { output: "Accepted.", isError: false, seconds: 0.5 },
      },
    ]);
  });

  it("shows a command without a result while it runs", () => {
    const running = feedOf(trajectory.slice(0, 3)).at(-1);

    expect(running).toMatchObject({ kind: "run", text: "ls /data/metric", result: undefined });
  });

  it("shows a restart of the shell and an API error", () => {
    const feed = feedOf([
      ...trajectory.slice(0, 2),
      response("40:03", 1, [{ type: "tool_use", id: "t", name: "bash", input: { restart: true } }]),
      event("api-error", "40:04", { status: 529, errorType: "overloaded_error", message: "Busy" }),
    ]);

    expect(feed.slice(-2).map((entry) => ("text" in entry ? entry.text : ""))).toEqual([
      "restart the shell",
      "API error 529: Busy",
    ]);
  });

  it("leaves the feed as it is for a line that is not a JSON event", () => {
    const feed = feedOf(trajectory.slice(0, 3));

    for (const text of ["", '{"at":"2026-11-18T09:41:00.000Z","type":"tool","id":"tool', "[1]"]) {
      expect(applyLine(feed, text)).toBe(feed);
    }
  });
});

function stateOf({
  tasks = [],
  rows = null,
  running = new Map(),
  planned = 6,
  usd = 0,
}: {
  readonly tasks?: readonly TaskRecord[];
  readonly rows?: readonly number[] | null;
  readonly running?: ReadonlyMap<number, number>;
  readonly planned?: number;
  readonly usd?: number;
}): RunState {
  return {
    folder: "/runs/telecom/20261118T094052Z-react",
    record: runRecord({ tasks, rows, usage: { ...noUsage, costUsd: usd } }),
    plan: Array.from({ length: planned }, (_, row) => ({ row, taskIndex: "task_2" })),
    running,
    scores: undefined,
  };
}

describe("boardOf", () => {
  it("shows each task of the plan as done, running, or pending", () => {
    const state = stateOf({
      tasks: [taskRecord(0, "answered", 70), taskRecord(2, "timeout", 3600)],
      running: new Map([[1, 0.25]]),
    });

    expect(boardOf(state).map((task) => [task.row, task.state.kind])).toEqual([
      [0, "done"],
      [1, "running"],
      [2, "done"],
      [3, "pending"],
      [4, "pending"],
      [5, "pending"],
    ]);
  });

  it("shows only the rows that the run covers", () => {
    const board = boardOf(stateOf({ rows: [1, 4] }));

    expect(board.map((task) => task.row)).toEqual([1, 4]);
  });

  it("shows the tasks it knows of when the plan is missing", () => {
    const state = stateOf({ tasks: [taskRecord(4, "answered", 9)], running: new Map([[7, 0]]) });
    const board = boardOf({ ...state, plan: undefined });

    expect(board.map((task) => [task.row, task.state.kind])).toEqual([
      [4, "done"],
      [7, "running"],
    ]);
  });
});

describe("the header", () => {
  it("adds what the running tasks have spent to what the run has recorded", () => {
    const running = new Map([
      [3, 0.25],
      [4, 0.125],
    ]);

    expect(spentUsd(stateOf({ usd: 1.5, running }))).toBe(1.875);
  });

  it("counts the outcomes, most common first", () => {
    const tasks = [
      taskRecord(0, "timeout", 1),
      taskRecord(1, "answered", 1),
      taskRecord(2, "answered", 1),
    ];

    expect(outcomeCounts(boardOf(stateOf({ tasks })))).toEqual([
      ["answered", 2],
      ["timeout", 1],
    ]);
  });

  it("estimates the time left from the mean time of a task and the tasks at a time", () => {
    const tasks = [
      taskRecord(0, "answered", 60),
      taskRecord(1, "answered", 120),
      taskRecord(2, "budget-exhausted", 0),
    ];

    expect(secondsLeft(boardOf(stateOf({ tasks })), 2)).toBe(135);
    expect(secondsLeft(boardOf(stateOf({})), 2)).toBeUndefined();
    expect(secondsLeft(boardOf(stateOf({ tasks, planned: 3 })), 2)).toBeUndefined();
  });
});

describe("the selection", () => {
  const board = boardOf(
    stateOf({
      tasks: [
        taskRecord(0, "answered", 1),
        taskRecord(1, "answered", 1),
        taskRecord(3, "answered", 1),
      ],
      running: new Map([
        [2, 0],
        [4, 0],
      ]),
    }),
  );
  const finished = boardOf(
    stateOf({ tasks: [taskRecord(0, "answered", 1), taskRecord(3, "answered", 1)] }),
  );

  it("shows the running task on the lowest row while live, or else the last done task", () => {
    expect(selectedRow(board, { kind: "live" })).toBe(2);
    expect(selectedRow(finished, { kind: "live" })).toBe(3);
    expect(selectedRow(boardOf(stateOf({})), { kind: "live" })).toBeUndefined();
    expect(selectedRow(board, { kind: "task", row: 1 })).toBe(1);
  });

  it("steps over the tasks that have not started and stops at either end", () => {
    expect(nextRow(board, 4, 1)).toBe(4);
    expect(nextRow(board, 4, -1)).toBe(3);
    expect(nextRow(board, 0, -1)).toBe(0);
    expect(nextRow(board, undefined, 1)).toBe(0);
  });

  it("cycles through the running tasks", () => {
    expect(nextRunning(board, 2)).toBe(4);
    expect(nextRunning(board, 4)).toBe(2);
    expect(nextRunning(board, 0)).toBe(2);
    expect(nextRunning(finished, 1)).toBe(1);
  });
});
