import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "./runs.js";
import { missingRun, readRunFolders, type Frame } from "./watch-folder.js";
import {
  bash,
  response,
  runRecord,
  runsFolder,
  taskEvent,
  taskRecord,
  tool,
} from "./watch-fixtures.js";

const live = { kind: "live" } as const;
const series = (run: number) => ({ id: "20261118T094052Z-react", run, runs: 5 });
const member = (run: number, changes: Partial<RunRecord> = {}) =>
  runRecord({ runId: `20261118T094052Z-react-${run}`, series: series(run), ...changes });
const noTokens = {
  inputTokens: 0,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
};
const request = (outputTokens: number) =>
  `${JSON.stringify({ kind: "forwarded", seconds: 1, error: null, tokens: { ...noTokens, outputTokens } })}\n`;

async function reader(runId?: string) {
  const folder = await runsFolder();
  const read = readRunFolders({
    runsDir: folder.runsDir,
    dataDir: join(folder.runsDir, "no-data"),
    scenarios: ["telecom", "bank"],
    runId: () => runId,
  });
  return { ...folder, read };
}

function shown(frame: Frame) {
  if (frame.kind !== "run") throw new Error(`No run: ${frame.message}`);
  return frame;
}

describe("readRunFolders", () => {
  it("waits for a run, then follows the newest run of a series to the next run", async () => {
    const { read, writeRun } = await reader();
    expect(await read(live)).toMatchObject({ kind: "waiting" });

    await writeRun(member(9));
    expect(shown(await read(live)).state.record.runId).toBe("20261118T094052Z-react-9");

    await writeRun(member(9, { endedAt: "2026-11-18T10:00:00.000Z" }));
    await writeRun(member(10));
    expect(shown(await read(live)).state.record.runId).toBe("20261118T094052Z-react-10");
  });

  it("shows the run that it names even when a newer run exists", async () => {
    const { read, writeRun } = await reader("20261118T094052Z-react-1");
    expect(await read(live)).toMatchObject({ kind: "waiting" });

    await writeRun(member(1));
    await writeRun(member(2));

    expect(shown(await read(live)).state.record.runId).toBe("20261118T094052Z-react-1");
  });

  it("shows a task as running from when its folder appears, before it has an out folder", async () => {
    const { read, writeRun, startTask } = await reader();
    const record = member(1);
    await writeRun(record);
    await startTask(record, 0);

    const frame = shown(await read(live));

    expect(frame.board[0]?.state).toEqual({ kind: "running", costUsd: 0 });
    expect(frame.row).toBe(0);
    expect(frame.feed).toEqual([]);
  });

  it("holds back a line that is still being written until it ends", async () => {
    const { read, writeRun, append } = await reader();
    const record = member(1);
    await writeRun(record);
    const first = response("41:00", 1, [bash("toolu_1", "ls /data")]);
    await append(record, 0, "trajectory", taskEvent("40:59", "Find the root cause."));
    await append(record, 0, "trajectory", first.slice(0, 40));

    expect(shown(await read(live)).feed.map((entry) => entry.kind)).toEqual(["task"]);

    await append(record, 0, "trajectory", first.slice(40));
    await append(record, 0, "trajectory", tool("41:01", "toolu_1", "metric\ntrace\n"));

    expect(shown(await read(live)).feed.at(-1)).toMatchObject({
      kind: "run",
      text: "ls /data",
      result: { output: "metric\ntrace\n" },
    });
  });

  it("adds up the cost of a running task's requests as they come", async () => {
    const { read, writeRun, append } = await reader();
    const record = member(1);
    await writeRun(record);
    await append(record, 0, "requests", request(1000));
    const before = shown(await read(live)).board[0]?.state;
    await append(record, 0, "requests", request(2000));
    const after = shown(await read(live)).board[0]?.state;

    expect(before).toMatchObject({ kind: "running", costUsd: 0.01 });
    expect(after).toMatchObject({ kind: "running", costUsd: 0.03 });
  });

  it("shows a task as done once run.json records it, and the scores once the run is scored", async () => {
    const { read, writeRun, startTask, writeScores } = await reader();
    const record = member(1);
    await writeRun(record);
    await startTask(record, 0);
    await writeScores(record, 0.5, 0.75);
    expect(shown(await read(live)).state.scores).toBeUndefined();

    const tasks = [taskRecord(0, "answered", 60)];
    await writeRun({ ...record, tasks, endedAt: "2026-11-18T10:00:00.000Z" });
    const frame = shown(await read(live));

    expect(frame.board[0]?.state.kind).toBe("done");
    expect(frame.state.scores?.summary.total).toEqual({ tasks: 1, strict: 0.5, partial: 0.75 });
  });

  it("starts the feed over when a resumed run writes the trajectory again", async () => {
    const { read, writeRun, append, runsDir } = await reader();
    const record = member(1);
    await writeRun(record);
    await append(
      record,
      0,
      "trajectory",
      taskEvent("40:00", "First attempt, with a long instruction."),
    );
    await read(live);

    await rm(join(runsDir, "telecom", record.runId, "tasks", "000"), { recursive: true });
    await append(record, 0, "trajectory", taskEvent("50:00", "Second attempt."));

    expect(shown(await read(live)).feed).toMatchObject([{ kind: "task", text: "Second attempt." }]);
  });

  it("empties the feed of a picked task whose folder a resume removes", async () => {
    const { read, writeRun, append, runsDir } = await reader();
    const record = member(1);
    await writeRun(record);
    await append(record, 0, "trajectory", taskEvent("40:00", "First attempt."));
    const picked = { kind: "task", row: 0 } as const;
    await read(picked);

    await rm(join(runsDir, "telecom", record.runId, "tasks", "000"), { recursive: true });
    expect(shown(await read(picked)).feed).toEqual([]);

    await append(record, 0, "trajectory", taskEvent("50:00", "Second attempt."));
    expect(shown(await read(picked)).feed).toMatchObject([{ text: "Second attempt." }]);
  });

  it("starts the feed over when the trajectory shrinks in place", async () => {
    const { read, writeRun, append, runsDir } = await reader();
    const record = member(1);
    await writeRun(record);
    const long = taskEvent("40:00", "First attempt, with a long instruction.");
    await append(record, 0, "trajectory", long);
    await read(live);

    const path = join(runsDir, "telecom", record.runId, "tasks", "000", "out", "trajectory.jsonl");
    await writeFile(path, taskEvent("50:00", "Second."));

    expect(shown(await read(live)).feed).toMatchObject([{ kind: "task", text: "Second." }]);
  });

  it("shows the first scenario of a run that is not scored yet, or else the last", async () => {
    const { read, writeRun } = await reader("20261118T094052Z-react");
    const telecom = runRecord({ scenario: "telecom" });
    const bank = runRecord({ scenario: "bank" });
    await writeRun(telecom);
    await writeRun(bank);
    expect(shown(await read(live)).state.record.scenario).toBe("telecom");

    const endedAt = "2026-11-18T10:00:00.000Z";
    await writeRun({ ...telecom, endedAt });
    expect(shown(await read(live)).state.record.scenario).toBe("bank");

    await writeRun({ ...bank, endedAt });
    expect(shown(await read(live)).state.record.scenario).toBe("bank");
  });

  it("shows the scenario whose tasks are running, whatever the order of the scenarios", async () => {
    const { read, writeRun, append } = await reader("20261118T094052Z-react");
    const telecom = runRecord({ scenario: "telecom" });
    const bank = runRecord({ scenario: "bank" });
    await writeRun(telecom);
    await writeRun(bank);
    await append(bank, 0, "trajectory", taskEvent("40:00", "A bank task."));

    expect(shown(await read(live)).state.record.scenario).toBe("bank");
  });

  it("reads the task that the user picks, and never changes the folder", async () => {
    const { read, writeRun, append, runsDir } = await reader();
    const record = member(1, { tasks: [taskRecord(0, "answered", 60)] });
    await writeRun(record);
    await append(record, 0, "trajectory", taskEvent("40:00", "Task zero."));
    await append(record, 1, "trajectory", taskEvent("42:00", "Task one."));
    const before = await snapshot(runsDir);

    const picked = shown(await read({ kind: "task", row: 0 }));
    const liveFrame = shown(await read(live));

    expect(picked.feed).toMatchObject([{ text: "Task zero." }]);
    expect(liveFrame.feed).toMatchObject([{ text: "Task one." }]);
    expect(await snapshot(runsDir)).toEqual(before);
  });
});

async function snapshot(dir: string) {
  const entries = await readdir(dir, { recursive: true });
  return Promise.all(
    entries.sort().map(async (entry) => {
      const { size, mtimeMs } = await stat(join(dir, entry));
      return [entry, size, mtimeMs];
    }),
  );
}

describe("missingRun", () => {
  const scenarios = ["telecom", "bank"] as const;

  it("finds a run in the folder of any scenario", async () => {
    const { runsDir, writeRun } = await runsFolder();
    await writeRun(member(1, { scenario: "bank" }));

    expect(await missingRun({ runsDir, scenarios }, "20261118T094052Z-react-1")).toBeUndefined();
  });

  it("names the run, the folder, and the newest runs for a run ID that no run has", async () => {
    const { runsDir, writeRun } = await runsFolder();
    for (const run of [1, 2, 9, 10]) await writeRun(member(run));
    await writeRun(member(10, { scenario: "bank" }));

    const message = await missingRun({ runsDir, scenarios }, "20261118T094052Z-react-11");

    expect(message).toContain("No run 20261118T094052Z-react-11");
    expect(message).toContain(runsDir);
    expect(message).toContain(
      "20261118T094052Z-react-10, 20261118T094052Z-react-9, 20261118T094052Z-react-2.",
    );
    expect(message).not.toContain("20261118T094052Z-react-1,");
  });

  it("says so when the folder holds no run", async () => {
    const { runsDir } = await runsFolder();

    expect(await missingRun({ runsDir, scenarios }, "20261118T094052Z-react")).toContain(
      "holds no run",
    );
  });
});
