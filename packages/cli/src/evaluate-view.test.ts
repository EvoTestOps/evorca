import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureConsole, followRuns, type LogLine } from "./evaluate-view.js";
import { runRecord, runsFolder } from "./watch-fixtures.js";

describe("captureConsole", () => {
  it("sends what the console prints to a function until it restores the console", () => {
    const original = console.log;
    const lines: LogLine[] = [];
    const restore = captureConsole((line) => lines.push(line));
    console.log("Seed %d.", 7);
    console.error("Stopped.");
    restore();

    expect(lines).toEqual([
      { text: "Seed 7.", stream: "stdout" },
      { text: "Stopped.", stream: "stderr" },
    ]);
    expect(console.log).toBe(original);
  });
});

describe("followRuns", () => {
  it("waits for the run that the evaluation starts, then shows it even when a newer run exists", async () => {
    const folder = await runsFolder();
    const { read, onRun } = followRuns({
      runsDir: folder.runsDir,
      dataDir: join(folder.runsDir, "no-data"),
      scenarios: ["telecom"],
    });
    await folder.writeRun(runRecord({ runId: "20261118T094052Z-react" }));
    await folder.writeRun(runRecord({ runId: "20261119T000000Z-react" }));

    expect(await read({ kind: "live" })).toEqual({ kind: "waiting", message: "Starting the run…" });

    onRun("20261118T094052Z-react");
    expect(await read({ kind: "live" })).toMatchObject({
      kind: "run",
      state: { record: { runId: "20261118T094052Z-react" } },
    });
  });
});
