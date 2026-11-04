import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readArchive } from "./archive.js";

async function archiveFile(...lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openrca-archive-"));
  onTestFinished(() => rm(dir, { recursive: true }));
  const path = join(dir, "agent-Telecom.csv");
  await writeFile(path, lines.join("\n"));
  return path;
}

describe("readArchive", () => {
  it("keys each row by its row_id, which the archive writes as a float", async () => {
    const path = await archiveFile("prediction,score,row_id", "{},0.5,1.0", "{},1.0,0.0");

    expect(await readArchive(path)).toEqual(
      new Map([
        [0, { prediction: "{}", score: 1 }],
        [1, { prediction: "{}", score: 0.5 }],
      ]),
    );
  });

  it.each(["high", "", "1.5"])("rejects the score %j, naming the file and row", async (score) => {
    const path = await archiveFile("row_id,prediction,score", "0.0,{},1.0", `1.0,{},${score}`);

    await expect(readArchive(path)).rejects.toThrow(`${path}, row 1: score`);
  });

  it.each(["-1.0", "0.5", ""])("rejects the row_id %j, naming the file and row", async (rowId) => {
    const path = await archiveFile("row_id,prediction,score", `${rowId},{},1.0`);

    await expect(readArchive(path)).rejects.toThrow(`${path}, row 0: row_id`);
  });
});
