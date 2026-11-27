import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

describe("evaluateFullScreen", () => {
  it("prints only the lines of the run once the view closes", async () => {
    const command = `
      import { evaluateFullScreen } from "./src/evaluate-view.tsx";
      const folders = { runsDir: "no-runs", dataDir: "no-data", scenarios: ["telecom"] };
      await evaluateFullScreen(folders, async () => {
        console.log("telecom: 2 answered");
        console.error("Stopped.");
      });
    `;
    const flags = [
      "--experimental-ffi",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
    ];
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [...flags, "--input-type=module", "-e", command],
      { cwd: fileURLToPath(new URL("..", import.meta.url)) },
    );

    expect(stdout.endsWith("telecom: 2 answered\n")).toBe(true);
    expect(stderr).toBe("Stopped.\n");
  });
});
