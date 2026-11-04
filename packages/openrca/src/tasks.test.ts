import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readTasks } from "./tasks.js";

describe("readTasks", () => {
  it("returns each query row as a task without its scoring points", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "openrca-"));
    onTestFinished(() => rm(dataDir, { recursive: true }));
    await mkdir(join(dataDir, "Telecom"));
    await writeFile(
      join(dataDir, "Telecom", "query.csv"),
      [
        "task_index,instruction,scoring_points",
        'task_2,"Find the reason, please.","The only predicted root cause reason is CPU fault',
        '"',
        'task_7,"Two failures',
        'happened.","The 1-th predicted root cause component is docker_003',
        "The 2-th predicted root cause component is db_007",
        '"',
        "",
      ].join("\n"),
    );

    expect(await readTasks("Telecom", dataDir)).toEqual([
      { system: "Telecom", row: 0, taskIndex: "task_2", instruction: "Find the reason, please." },
      { system: "Telecom", row: 1, taskIndex: "task_7", instruction: "Two failures\nhappened." },
    ]);
  });
});
