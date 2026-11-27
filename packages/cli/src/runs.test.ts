import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { agents } from "./agents.js";
import {
  conflicts,
  parseRows,
  runPool,
  tasksToRun,
  writeJson,
  type Conditions,
  type TaskRecord,
} from "./runs.js";

const { jobs: _, ...random } = agents.random;
const recorded: Conditions = {
  agent: { name: "random", ...random, image: "evorca-agent-random:abc", imageId: "sha256:1" },
  seed: 7,
  rows: [0, 7, 21],
  model: null,
};
const model: NonNullable<Conditions["model"]> = {
  id: "claude-sonnet-5",
  effort: "high",
  taskBudgetUsd: 2,
  upstreamUrl: "https://api.anthropic.com",
  prices: {
    table: "anthropic-2026-11-17",
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    checkedAt: "2026-11-17",
    usdPerMTok: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  },
};

describe("conflicts", () => {
  it("accepts a resume that asks for nothing or for the run's own settings", () => {
    expect(conflicts(recorded, {})).toEqual([]);
    expect(
      conflicts(recorded, { seed: 7, rows: [0, 7, 21], agent: { ...recorded.agent } }),
    ).toEqual([]);
  });

  it("names each setting that differs from the run's", () => {
    const problems = conflicts(recorded, {
      seed: 8,
      rows: [0, 7],
      agent: { ...recorded.agent, imageId: "sha256:2" },
    });

    expect(problems).toEqual([
      'agent.imageId: the run has "sha256:1", not "sha256:2"',
      "seed: the run has 7, not 8",
      "rows: the run has [0,7,21], not [0,7]",
    ]);
  });

  it("rejects a subset of rows on a run of every row", () => {
    expect(conflicts({ ...recorded, rows: null }, { rows: [0] })).toEqual([
      "rows: the run has null, not [0]",
    ]);
  });

  it.each([
    [{ ...model, effort: "low" as const }, 'model.effort: the run has "high", not "low"'],
    [{ ...model, taskBudgetUsd: 5 }, "model.taskBudgetUsd: the run has 2, not 5"],
    [
      { ...model, upstreamUrl: "http://127.0.0.1:9999" },
      'model.upstreamUrl: the run has "https://api.anthropic.com", not "http://127.0.0.1:9999"',
    ],
    [
      { ...model, prices: { ...model.prices, table: "anthropic-2027-01-01" } },
      'model.prices.table: the run has "anthropic-2026-11-17", not "anthropic-2027-01-01"',
    ],
  ])("names the model setting that differs", (requested, problem) => {
    expect(conflicts({ ...recorded, model }, { model: requested })).toEqual([problem]);
  });

  it("rejects a model on a run without one", () => {
    expect(conflicts(recorded, { model })).toEqual([
      `model: the run has null, not ${JSON.stringify(model)}`,
    ]);
  });
});

describe("parseRows", () => {
  const scenarios = ["bank", "telecom", "market-cloudbed-1"] as const;

  it("gives every scenario the rows of a value without a scenario, in order", () => {
    expect(parseRows(["21,0,7"], scenarios)).toEqual(
      new Map([
        ["bank", [0, 7, 21]],
        ["telecom", [0, 7, 21]],
        ["market-cloudbed-1", [0, 7, 21]],
      ]),
    );
  });

  it("gives a scenario that a value names only those rows, and leaves the others whole", () => {
    expect(parseRows(["telecom:3,1", "bank:0"], scenarios)).toEqual(
      new Map([
        ["telecom", [1, 3]],
        ["bank", [0]],
      ]),
    );
  });

  it("gives the rows of a value without a scenario to each scenario that no value names", () => {
    expect(parseRows(["bank:4", "0,7"], scenarios)).toEqual(
      new Map([
        ["bank", [4]],
        ["telecom", [0, 7]],
        ["market-cloudbed-1", [0, 7]],
      ]),
    );
  });

  it("adds up the rows of the values for one scenario, and of the values without a scenario", () => {
    expect(parseRows(["telecom:7,3", "21", "telecom:1", "0"], scenarios)).toEqual(
      new Map([
        ["telecom", [1, 3, 7]],
        ["bank", [0, 21]],
        ["market-cloudbed-1", [0, 21]],
      ]),
    );
  });

  it("refuses a value of another form and a scenario outside the run", () => {
    for (const values of [["0,,7"], ["telecom:"], ["x"]]) {
      expect(parseRows(values, scenarios)).toEqual(expect.any(String));
    }
    expect(parseRows(["market-cloudbed-2:0"], scenarios)).toContain("market-cloudbed-2");
  });

  it("refuses a row given twice, and names the row and its scenario", () => {
    expect(parseRows(["1,1"], scenarios)).toBe("--rows gives row 1 twice.");
    expect(parseRows(["0,7", "3,7"], scenarios)).toBe("--rows gives row 7 twice.");
    expect(parseRows(["telecom:2,5,2"], scenarios)).toBe("--rows gives row 2 of telecom twice.");
    expect(parseRows(["telecom:1,2", "bank:2", "telecom:2"], scenarios)).toBe(
      "--rows gives row 2 of telecom twice.",
    );
  });

  it("lets a value without a scenario and a value for a scenario give the same row", () => {
    expect(parseRows(["1", "bank:1"], ["bank", "telecom"])).toEqual(
      new Map([
        ["bank", [1]],
        ["telecom", [1]],
      ]),
    );
  });
});

describe("tasksToRun", () => {
  const record = (row: number, outcome: TaskRecord["outcome"] = "answered"): TaskRecord => ({
    row,
    taskIndex: "task_1",
    outcome,
    exitCode: 0,
    seconds: 1,
    usage: null,
  });

  it("keeps the tasks without an outcome, in task order", () => {
    const tasks = [0, 1, 2, 3, 4].map((row) => ({ row }));

    expect(tasksToRun(tasks, [record(3), record(0)])).toEqual([{ row: 1 }, { row: 2 }, { row: 4 }]);
  });

  it("runs again a task that the run's budget kept from starting or that a stop cut short", () => {
    const tasks = [0, 1, 2, 3].map((row) => ({ row }));
    const records = [record(0), record(1, "budget-exhausted"), record(2, "timeout")];

    expect(tasksToRun(tasks, [...records, record(3, "stopped")])).toEqual([{ row: 1 }, { row: 3 }]);
  });

  it("runs every task of a new run and none of a finished one", () => {
    const tasks = [0, 1].map((row) => ({ row }));

    expect(tasksToRun(tasks, [])).toEqual(tasks);
    expect(tasksToRun(tasks, [record(0), record(1)])).toEqual([]);
  });
});

describe("runPool", () => {
  const rows = Array.from({ length: 24 }, (_, row) => row);

  function answer(seed: number, row: number): string {
    return createHash("sha256").update(`${seed}/${row}`).digest("hex").slice(0, 12);
  }

  async function runAll(jobs: number) {
    const answers = new Map<number, string>();
    let running = 0;
    let most = 0;
    await runPool(rows, jobs, async (row) => {
      running += 1;
      most = Math.max(most, running);
      await sleep(Math.random() * 5);
      answers.set(row, answer(7, row));
      running -= 1;
    });
    return { answers: [...answers].sort(([a], [b]) => a - b), most };
  }

  it("gives the same answers with 1 job and with 4", async () => {
    const one = await runAll(1);
    const four = await runAll(4);

    expect(four.answers).toEqual(one.answers);
    expect(one.answers).toHaveLength(rows.length);
    expect(one.most).toBe(1);
    expect(four.most).toBe(4);
  });

  it("starts no task after one throws, waits for the others, and throws the error", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const run = runPool(rows, 3, async (row) => {
      started.push(row);
      if (row === 4) throw new Error("docker run failed");
      await sleep(10);
      finished.push(row);
    });

    await expect(run).rejects.toThrow("docker run failed");
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(finished).toEqual([0, 1, 2, 3]);
  });

  it("starts no task after the signal aborts", async () => {
    const stop = new AbortController();
    const started: number[] = [];
    await runPool(
      rows,
      2,
      async (row) => {
        started.push(row);
        if (row === 3) stop.abort();
        await sleep(1);
      },
      stop.signal,
    );

    expect(started).toEqual([0, 1, 2, 3]);
  });
});

describe("writeJson", () => {
  it("writes indented JSON and leaves no staging file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evorca-runs-"));
    const path = join(dir, "run.json");
    await writeJson(path, { tasks: [] });
    await writeJson(path, { tasks: [{ row: 0 }] });

    expect(await readFile(path, "utf8")).toBe(
      '{\n  "tasks": [\n    {\n      "row": 0\n    }\n  ]\n}\n',
    );
    expect(await readdir(dir)).toEqual(["run.json"]);
  });
});
