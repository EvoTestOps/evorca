import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManualClock, type TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agents } from "./agents.js";
import { noUsage } from "./models.js";
import type { RunRecord } from "./runs.js";
import { readRunFolders, type Frame } from "./watch-folder.js";
import {
  bash,
  response,
  runRecord,
  runsFolder,
  taskEvent,
  taskRecord,
  tool,
} from "./watch-fixtures.js";
import { Watch, type WatchProps } from "./watch-view.js";
import type { Selection } from "./watch.js";

let setup: TestRendererSetup;
let clock: ManualClock;
let onExit: () => void;
let reads: Promise<Frame>[];
let folder: Awaited<ReturnType<typeof runsFolder>>;

const record = runRecord({
  runId: "20261118T094052Z-react-2",
  series: { id: "20261118T094052Z-react", run: 2, runs: 5 },
  tasks: [taskRecord(0, "answered", 60, 0.5), taskRecord(1, "timeout", 3600, 1.25)],
  usage: { ...noUsage, requests: 2, costUsd: 1.75 },
});
const finished = runRecord({
  runId: "20261127T062559Z-react",
  rows: Array.from({ length: 51 }, (_, row) => row),
  tasks: Array.from({ length: 51 }, (_, row) => taskRecord(row, "answered", 125.82, 0.2982)),
  usage: { ...noUsage, requests: 51, costUsd: 23.84 },
  endedAt: "2026-11-18T11:00:00.000Z",
});
const { jobs: _, ...random } = agents.random;
const unpriced = runRecord({
  runId: "20261118T094052Z-random",
  agent: { name: "random", ...random, image: "evorca-agent-random:abc", imageId: "sha256:2" },
  model: null,
  budgetUsd: null,
  tasks: [{ ...taskRecord(0, "answered", 1.5), usage: null }],
  usage: null,
});
const local = (time: string) =>
  new Date(Date.parse(`2026-11-18T09:${time}.000Z`)).toTimeString().slice(0, 8);
const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");

async function open(
  run: RunRecord | null = record,
  height = 40,
  props: Partial<WatchProps> = {},
  width = 120,
) {
  folder = await runsFolder();
  const dataDir = join(folder.runsDir, "benchmarks");
  await mkdir(join(dataDir, "telecom"), { recursive: true });
  const rows = Array.from({ length: 6 }, (_, row) => `task_2,Task ${row}.,points`);
  await writeFile(
    join(dataDir, "telecom", "query.csv"),
    ["task_index,instruction,scoring_points", ...rows].join("\n"),
  );
  if (run !== null) await folder.writeRun(run);
  const real = readRunFolders({
    runsDir: folder.runsDir,
    dataDir,
    scenarios: ["telecom"],
    runId: () => undefined,
  });
  reads = [];
  const read = (selection: Selection) => {
    const frame = real(selection);
    reads.push(frame);
    return frame;
  };
  clock = new ManualClock();
  onExit = vi.fn();
  const wallTime = () => new Date(Date.parse("2026-11-18T10:10:00.000Z") + clock.now());
  setup = await testRender(<Watch read={read} wallTime={wallTime} onExit={onExit} {...props} />, {
    width,
    height,
    clock,
  });
  return settle();
}

async function settle() {
  await act(async () => {
    while (reads.length > 0) await reads.shift();
  });
  await setup.renderOnce();
  return setup.captureCharFrame();
}

async function poll() {
  await act(async () => clock.setTime(clock.now() + 1000));
  return settle();
}

const presses = {
  left: () => setup.mockInput.pressArrow("left"),
  right: () => setup.mockInput.pressArrow("right"),
  up: () => setup.mockInput.pressArrow("up"),
  tab: () => setup.mockInput.pressTab(),
  end: () => setup.mockInput.pressKey("END"),
  o: () => setup.mockInput.typeText("o"),
  f: () => setup.mockInput.typeText("f"),
  q: () => setup.mockInput.typeText("q"),
};

async function press(key: keyof typeof presses) {
  await act(async () => presses[key]());
  return settle();
}

async function growTask(row: number, output: string) {
  await folder.append(
    record,
    row,
    "trajectory",
    taskEvent("40:00", `Find the cause of task ${row}.`),
  );
  await folder.append(
    record,
    row,
    "trajectory",
    response("40:03", 1, [bash("t1", "cat metrics.csv")]),
  );
  await folder.append(record, row, "trajectory", tool("40:04", "t1", output));
}

function nonGrays() {
  return setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .flatMap((span) => [span.fg, span.bg].map((color) => color.toInts()))
    .filter(([r, g, b]) => r !== g || g !== b);
}

describe("Watch", () => {
  afterEach(() => act(() => setup.renderer.destroy()));

  it("waits for a run to appear", async () => {
    const frame = await open(null);

    expect(frame).toContain("No run yet in");

    await folder.writeRun(record);
    expect(await poll()).toContain("20261118T094052Z-react-2");
  });

  it("shows the run, its board, and the live task's commands with the output the agent sees", async () => {
    await open();
    await growTask(2, "time,value\n1,2\n");
    const frame = await poll();

    expect(frame).toMatch(/telecom +run 2 of 5 +20261118T094052Z-react-2 +claude-sonnet-5 high/);
    expect(frame).toMatch(
      /2\/6 tasks +1 answered +1 timeout +\$1\.7500 of \$50\.00 +30m 0\ds elapsed/,
    );
    expect(frame).toContain("about 1h 01m left, estimated");
    expect(frame).toContain("• × • • • •");
    expect(frame).toMatch(/task 002 +task_2 +running/);
    expect(frame).toMatch(new RegExp(`${local("40:00")} +task +Find the cause of task 2\\.`));
    expect(frame).toMatch(
      new RegExp(`${local("40:03")} +\\$ +cat metrics\\.csv *\n +time,value *\n +1,2`),
    );
    expect(nonGrays()).toEqual([]);
  });

  it("folds long output to a few lines, and shows all of it on o", async () => {
    await open();
    await growTask(2, lines(20, "row"));
    const folded = await poll();

    expect(folded).toMatch(/row 6 *\n/);
    expect(folded).not.toMatch(/row 7 *\n/);
    expect(folded).toContain("… 14 more lines, o to show all");

    const unfolded = await press("o");
    expect(unfolded).toContain("row 20");
    expect(unfolded).not.toContain("more lines");
  });

  it("moves between the tasks that started, and to the next running task on tab", async () => {
    await open();
    await growTask(2, "two");
    await folder.append(record, 0, "trajectory", taskEvent("30:00", "Find the cause of task 0."));
    await folder.startTask(record, 3);
    await poll();

    expect(await press("left")).toMatch(/task 001 +task_2 +timeout +3600\.00 s +\$1\.2500 +picked/);
    expect(await press("left")).toContain("Find the cause of task 0.");
    expect(await press("tab")).toMatch(/task 002 +task_2 +running/);
    expect(await press("tab")).toMatch(/task 003 +task_2 +running/);
    expect(await press("f")).toMatch(/task 002 +task_2 +running .* live/);
  });

  it("pauses the tail when the user scrolls up, and tails again on end", async () => {
    await open(record, 24);
    await growTask(2, lines(5, "first"));
    await poll();
    await folder.append(record, 2, "trajectory", response("41:00", 2, [bash("t2", "ls")]));
    await folder.append(record, 2, "trajectory", tool("41:01", "t2", lines(5, "second")));
    expect(await poll()).toContain("second 5");

    const paused = await press("up");
    expect(paused).toContain("paused end to tail");
    await folder.append(record, 2, "trajectory", response("42:00", 3, [bash("t3", "ls")]));
    await folder.append(record, 2, "trajectory", tool("42:01", "t3", "third"));
    expect(await poll()).not.toContain("third");

    const tailing = await press("end");
    expect(tailing).toContain("tailing");
    expect(tailing).toContain("third");
    await folder.append(record, 2, "trajectory", response("43:00", 4, [bash("t4", "ls")]));
    await folder.append(record, 2, "trajectory", tool("43:01", "t4", "fourth"));
    expect(await poll()).toContain("fourth");
  });

  it("shows the end of a task that the user switches to after scrolling up", async () => {
    await open(record, 24);
    await growTask(2, lines(30, "two"));
    await folder.append(record, 3, "trajectory", taskEvent("45:00", "Task three."));
    await folder.append(record, 3, "trajectory", response("45:01", 1, [bash("t9", "ls")]));
    await folder.append(record, 3, "trajectory", tool("45:02", "t9", lines(30, "three")));
    await press("o");
    await poll();
    await press("up");
    await press("up");

    const switched = await press("tab");

    expect(switched).toMatch(/task 003 +task_2 +running/);
    expect(switched).toContain("three 30");
    expect(switched).toContain("tailing");
  });

  it("shows no result for a command whose output can no longer come", async () => {
    await open();
    await folder.append(record, 2, "trajectory", taskEvent("40:00", "Find the cause of task 2."));
    await folder.append(record, 2, "trajectory", response("40:01", 1, [bash("t1", "cut off")]));
    await folder.append(record, 2, "trajectory", response("40:02", 2, [bash("t2", "in flight")]));
    expect(await poll()).toMatch(/cut off *\n +no result[^]*in flight *\n +running…/);

    await folder.append(record, 1, "trajectory", taskEvent("30:00", "Find the cause of task 1."));
    await folder.append(record, 1, "trajectory", response("30:01", 1, [bash("t1", "sleep 9")]));
    expect(await press("left")).toMatch(/sleep 9 *\n +no result/);
  });

  it("goes back to the live task when the series moves to its next run", async () => {
    await open();
    await growTask(2, "two");
    await poll();
    await press("left");
    const next = runRecord({
      runId: "20261118T094052Z-react-3",
      series: { id: "20261118T094052Z-react", run: 3, runs: 5 },
    });
    await folder.writeRun(next);
    await folder.append(next, 0, "trajectory", taskEvent("50:00", "Run three, task zero."));

    await poll();
    const frame = await settle();

    expect(frame).toContain("run 3 of 5");
    expect(frame).toMatch(/task 000 +task_2 +running .* live/);
    expect(frame).toContain("Run three, task zero.");
  });

  it("gives the time since the last resume of a resumed run", async () => {
    const resume = {
      startedAt: "2026-11-18T10:00:00.000Z",
      git: record.git,
      versions: record.versions,
    };

    expect(await open({ ...record, resumes: [resume] })).toMatch(/10m 00s +since resume/);
  });

  it("shows the last lines that the runner printed, and ctrl+c to stop it without onExit", async () => {
    const log = [
      "Agent random.",
      "Seed 7.",
      "",
      "Run 1 of 2.",
      "task 000 answered",
      "task 001 answered",
    ];
    const frame = await open(record, 40, { log: () => log, onExit: undefined });

    expect(frame).toMatch(
      /Seed 7\. *\n +Run 1 of 2\. *\n +task 000 answered *\n +task 001 answered/,
    );
    expect(frame).not.toContain("Agent random.");
    expect(frame).toContain("ctrl+c stop");
    expect(frame).not.toContain("q quit");
  });

  it.each([
    [40, 10],
    [60, 14],
    [80, 24],
    [120, 40],
  ])("keeps the task line, the keys, and the footer apart at %i by %i", async (width, height) => {
    await open(finished, height, {}, width);
    await folder.writeScores(finished, 0.4314, 0.5525);
    await folder.append(finished, 50, "trajectory", taskEvent("40:00", "Find it."));
    const frame = await poll();
    const rows = frame.split("\n").map((row) => row.trim());

    expect(rows.every((row) => row.length <= width - 4)).toBe(true);
    if (height >= 14) expect(frame).toContain("Find it.");
    expect(rows.filter((row) => row.includes("task 050"))).toEqual([
      expect.stringMatching(/^task 050( {3}\S+( \S+)*)* {3,}live {3}tailing$/),
    ]);
    for (const row of rows.filter((row) => row.includes("quit"))) {
      expect(row).toMatch(/^(\S+ \S+ {3})*q quit$/);
    }
    for (const row of rows.filter((row) => row.includes("v0."))) {
      expect(row).toMatch(/^(\S+ +)?evorca v\d+\.\d+\.\d+$/);
    }
  });

  it("keeps the keys and the footer on a terminal with room for them", async () => {
    await open(finished, 24, {}, 80);
    const frame = await poll();

    expect(frame).toContain("q quit");
    expect(frame).toMatch(/20261127T062559Z-react +evorca v/);
  });

  it("shows no cost for a run whose agent calls no model", async () => {
    await open(unpriced);
    await folder.startTask(unpriced, 1);
    const frame = await poll();

    expect(frame).toMatch(/1\/6 tasks +1 answered +30m 0\ds elapsed/);
    expect(frame).toMatch(/task 001 +task_2 +running/);
    expect(frame).not.toContain("$");
    expect(frame).not.toContain("spent");
  });

  it("calls onExit on q", async () => {
    await open();
    await press("q");

    expect(onExit).toHaveBeenCalledOnce();
  });
});
