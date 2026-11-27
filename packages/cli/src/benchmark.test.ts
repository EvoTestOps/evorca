import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenRcaScenario, OpenRcaTask, TaskIndex } from "@evorca/openrca";
import { describe, expect, it } from "vitest";
import {
  blockerOf,
  commandOf,
  estimateOf,
  itemsOf,
  openPicker,
  planOf,
  readCatalog,
  update,
  type Action,
  type Catalog,
  type Picker,
} from "./benchmark.js";
import { noUsage } from "./models.js";
import { parseRows, type RunRecord } from "./runs.js";
import { runRecord, taskRecord } from "./watch-fixtures.js";

function tasks(scenario: OpenRcaScenario, indices: readonly TaskIndex[]): OpenRcaTask[] {
  return indices.map((taskIndex, row) => ({
    scenario,
    row,
    taskIndex,
    instruction: `Find the cause of ${scenario} task ${row}.`,
  }));
}

const catalog: Catalog = {
  scenarios: [
    { scenario: "bank", tasks: tasks("bank", ["task_1", "task_5"]), telemetry: false },
    {
      scenario: "telecom",
      tasks: tasks("telecom", ["task_1", "task_4", "task_7", "task_2", "task_6"]),
      telemetry: true,
    },
    { scenario: "market-cloudbed-1", tasks: [], telemetry: false },
  ],
  runs: [],
};

function press(picker: Picker, ...actions: Action[]): Picker {
  return actions.reduce((state, action) => {
    const next = update(state, action, catalog);
    if (typeof next === "string") throw new Error(`The picker answered ${next} to ${action}.`);
    return next;
  }, picker);
}

const start = openPicker(catalog, 7);
const bothChosen = press(start, "toggle", "down", "toggle", "next");

describe("the picker", () => {
  it("chooses scenarios with tasks, and not one without tasks, which names the fetch command", () => {
    const picker = press(start, "toggle", "down", "down", "toggle");
    const items = itemsOf(picker, catalog);

    expect(items.map((item) => item.kind === "scenario" && item.chosen)).toEqual([
      true,
      false,
      false,
    ]);
    expect(items[2]).toMatchObject({
      problem: expect.stringContaining(
        "pnpm evorca fetch --benchmark=openrca --scenario=market-cloudbed-1",
      ),
    });
  });

  it("goes on from the scenarios only once one is chosen, and closes on back", () => {
    expect(update(start, "next", catalog)).toBe(start);
    expect(update(start, "back", catalog)).toBe("cancel");
    expect(bothChosen.step).toBe("tasks");
  });

  it("lists the tasks of each chosen scenario under its name, every task chosen", () => {
    const lines = itemsOf(bothChosen, catalog).map((item) =>
      item.kind === "group"
        ? `${item.scenario} ${item.chosen}/${item.tasks}`
        : item.kind === "task"
          ? `${item.chosen ? "x" : "-"} ${item.task.row} ${item.task.taskIndex} ${item.difficulty}`
          : "",
    );

    expect(lines).toEqual([
      "bank 2/2",
      "x 0 task_1 easy",
      "x 1 task_5 middle",
      "telecom 5/5",
      "x 0 task_1 easy",
      "x 1 task_4 middle",
      "x 2 task_7 hard",
      "x 3 task_2 easy",
      "x 4 task_6 middle",
    ]);
  });

  it("drops one task, the tasks of a difficulty in the scenario under the cursor, or a whole scenario", () => {
    const onTelecom = press(bothChosen, "down", "down", "down", "down");
    const oneDropped = press(onTelecom, "toggle");
    const middleDropped = press(onTelecom, "middle");
    const middleBack = press(middleDropped, "middle");
    const bankDropped = press(bothChosen, "toggle");

    expect(planOf(oneDropped, catalog).rows).toEqual(new Map([["telecom", [1, 2, 3, 4]]]));
    expect(planOf(middleDropped, catalog).rows).toEqual(new Map([["telecom", [0, 2, 3]]]));
    expect(planOf(middleBack, catalog).rows).toEqual(new Map());
    expect(planOf(bankDropped, catalog).scenarios).toEqual(["telecom"]);
  });

  it("chooses every task of a difficulty when some of them are dropped", () => {
    const onTelecom = press(bothChosen, "down", "down", "down", "down");
    const picker = press(onTelecom, "toggle", "easy");

    expect(planOf(picker, catalog).rows).toEqual(new Map());
  });

  it("goes on from the tasks only while one is chosen", () => {
    const none = press(bothChosen, "toggle", "down", "down", "down", "toggle");

    expect(update(none, "next", catalog)).toBe(none);
    expect(press(bothChosen, "next").step).toBe("agent");
  });

  it("shows the model settings only for an agent that calls a model, and changes the one under the cursor", () => {
    const agentStep = press(bothChosen, "next");
    const random = itemsOf(agentStep, catalog).map((item) => item.kind === "setting" && item.label);
    const react = press(agentStep, "right", "down", "right", "down", "down", "right");
    const settings = itemsOf(react, catalog).map(
      (item) => item.kind === "setting" && `${item.label} ${item.value}`,
    );

    expect(random).toEqual(["agent", "runs"]);
    expect(settings).toEqual([
      "agent react",
      "runs 2",
      "model claude-sonnet-5",
      "effort xhigh",
      "run budget $50",
      "task budget $2",
    ]);
  });

  it("refuses an agent that reads telemetry that a chosen scenario lacks, and names the fetch command", () => {
    const react = press(bothChosen, "next", "right");
    const telecomOnly = press(start, "down", "toggle", "next", "next", "right");

    expect(update(react, "next", catalog)).toBe(react);
    expect(blockerOf(react, catalog)).toBe(
      "Fetch the telemetry that react reads with pnpm evorca fetch --benchmark=openrca --scenario=bank",
    );
    expect(press(telecomOnly, "next").step).toBe("confirm");
  });

  it("starts the run once confirmed, and steps back on back", () => {
    const confirm = press(bothChosen, "next", "next");

    expect(update(confirm, "next", catalog)).toBe("start");
    expect(press(confirm, "back").step).toBe("agent");
  });
});

describe("commandOf", () => {
  const oneLine = (command: string) => command.replaceAll(" \\\n  ", " ");

  it("repeats the pick with the seed, each scenario, the rows of each scenario it does not run whole, and the runs", () => {
    const picker = press(bothChosen, "down", "toggle", "next", "down", "right");
    const plan = planOf(picker, catalog);

    expect(oneLine(commandOf(plan))).toBe(
      "EVORCA_SEED=7 pnpm evorca evaluate --benchmark=openrca --agent=random --scenario=bank" +
        " --scenario=telecom --rows=bank:1 --runs=2",
    );
  });

  it("gives the rows that --rows parses back to the plan's", () => {
    const picker = press(bothChosen, "down", "toggle", "down", "down", "down", "hard");
    const plan = planOf(picker, catalog);
    const values = oneLine(commandOf(plan))
      .split(" ")
      .filter((flag) => flag.startsWith("--rows="))
      .map((flag) => flag.slice("--rows=".length));

    expect(parseRows(values, plan.scenarios)).toEqual(plan.rows);
    expect(plan.rows).toEqual(
      new Map([
        ["bank", [1]],
        ["telecom", [0, 1, 3, 4]],
      ]),
    );
  });

  it("names every model setting for an agent that calls a model", () => {
    const telecomOnly = press(start, "down", "toggle", "next", "next", "right");

    expect(oneLine(commandOf(planOf(telecomOnly, catalog)))).toBe(
      "EVORCA_SEED=7 pnpm evorca evaluate --benchmark=openrca --agent=react --scenario=telecom" +
        " --model=claude-sonnet-5 --effort=high --budget-usd=50 --task-budget-usd=2",
    );
  });

  it("breaks into lines of at most 72 columns that continue with a backslash", () => {
    const telecomOnly = press(start, "down", "toggle", "next", "next", "right");

    expect(commandOf(planOf(telecomOnly, catalog)).split("\n")).toEqual([
      "EVORCA_SEED=7 pnpm evorca evaluate --benchmark=openrca --agent=react \\",
      "  --scenario=telecom --model=claude-sonnet-5 --effort=high \\",
      "  --budget-usd=50 --task-budget-usd=2",
    ]);
  });

  it("splits the rows of a scenario over several --rows values, so no line is wider than asked", () => {
    const rows = Array.from({ length: 100 }, (_, index) => 2 * index);
    const plan = { ...planOf(bothChosen, catalog), rows: new Map([["telecom", rows] as const]) };
    const lines = commandOf(plan, 60).split("\n");
    const values = oneLine(lines.join("\n"))
      .split(" ")
      .filter((flag) => flag.startsWith("--rows="))
      .map((flag) => flag.slice("--rows=".length));

    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(60);
    expect(lines.slice(0, -1).every((line) => line.endsWith(" \\"))).toBe(true);
    expect(parseRows(values, plan.scenarios)).toEqual(plan.rows);
  });
});

describe("estimateOf", () => {
  const react = (changes: Partial<RunRecord>) =>
    runRecord({
      endedAt: "2026-11-18T10:00:00.000Z",
      tasks: [taskRecord(0, "answered", 0.3), taskRecord(1, "answered", 0.5)],
      usage: { ...noUsage, costUsd: 1.5 },
      ...changes,
    });
  const { model } = runRecord();
  const telecomOnly = press(start, "down", "toggle", "next", "next", "right", "down", "right");

  it("multiplies the tasks of every run by the mean cost per task of finished runs of the same agent and model", () => {
    const runs = [react({}), react({ usage: { ...noUsage, costUsd: 0.5 } })];
    const estimate = estimateOf(planOf(telecomOnly, catalog), { ...catalog, runs });

    expect(estimate).toEqual({ usd: 5, perTaskUsd: 0.5, from: 4 });
  });

  it("gives none without a finished run of the same agent, model, and effort, or for an agent that calls no model", () => {
    const xhigh = react({ model: model && { ...model, effort: "xhigh" } });
    const unfinished = react({ endedAt: null });
    const random = press(start, "down", "toggle", "next", "next");

    expect(
      estimateOf(planOf(telecomOnly, catalog), { ...catalog, runs: [xhigh, unfinished] }),
    ).toBe(undefined);
    expect(estimateOf(planOf(random, catalog), { ...catalog, runs: [react({})] })).toBe(undefined);
  });
});

describe("readCatalog", () => {
  it("reads each scenario's tasks without their scoring points, its telemetry, and the runs on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "evorca-catalog-"));
    const dataDir = join(root, "data");
    const runsDir = join(root, "runs");
    await mkdir(join(dataDir, "telecom", "telemetry"), { recursive: true });
    await mkdir(join(dataDir, "bank"), { recursive: true });
    await writeFile(
      join(dataDir, "telecom", "query.csv"),
      "task_index,instruction,scoring_points\ntask_2,Find the reason.,SECRET\n",
    );
    await writeFile(
      join(dataDir, "bank", "query.csv"),
      "task_index,instruction,scoring_points\ntask_7,Find it all.,SECRET\n",
    );
    const record = runRecord();
    await mkdir(join(runsDir, "telecom", record.runId), { recursive: true });
    await writeFile(join(runsDir, "telecom", record.runId, "run.json"), JSON.stringify(record));

    const read = await readCatalog(dataDir, runsDir);

    expect(read.scenarios).toEqual([
      {
        scenario: "bank",
        tasks: [{ scenario: "bank", row: 0, taskIndex: "task_7", instruction: "Find it all." }],
        telemetry: false,
      },
      {
        scenario: "telecom",
        tasks: [
          { scenario: "telecom", row: 0, taskIndex: "task_2", instruction: "Find the reason." },
        ],
        telemetry: true,
      },
      { scenario: "market-cloudbed-1", tasks: [], telemetry: false },
      { scenario: "market-cloudbed-2", tasks: [], telemetry: false },
    ]);
    expect(JSON.stringify(read.scenarios)).not.toContain("SECRET");
    expect(read.runs).toEqual([record]);
  });
});
