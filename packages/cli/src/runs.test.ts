import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { agents } from "./agents.js";
import {
  conflicts,
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

    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^agent: /);
    expect(problems[1]).toBe("seed: the run has 7, not 8");
    expect(problems[2]).toBe("rows: the run has [0,7,21], not [0,7]");
  });

  it("rejects a subset of rows on a run of every row", () => {
    expect(conflicts({ ...recorded, rows: null }, { rows: [0] })).toEqual([
      "rows: the run has null, not [0]",
    ]);
  });
});

describe("tasksToRun", () => {
  const record = (row: number): TaskRecord => ({
    row,
    taskIndex: "task_1",
    outcome: "answered",
    exitCode: 0,
    seconds: 1,
  });

  it("keeps the tasks without an outcome, in task order", () => {
    const tasks = [0, 1, 2, 3, 4].map((row) => ({ row }));

    expect(tasksToRun(tasks, [record(3), record(0)])).toEqual([{ row: 1 }, { row: 2 }, { row: 4 }]);
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
