import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

async function evorca(...args: string[]) {
  return promisify(execFile)(process.execPath, ["--import", "tsx", "src/main.ts", ...args], {
    cwd: packageDir,
  }).then(
    ({ stderr }) => ({ code: 0, stderr }),
    (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
  );
}

describe("evorca", () => {
  it("exits with code 1 and lists the commands for an unknown command", async () => {
    const { code, stderr } = await evorca("nope", "--benchmark=openrca");

    expect(code).toBe(1);
    expect(stderr).toContain("fetch");
    expect(stderr).toContain("reproduce");
  });
});

describe.each(["fetch", "reproduce"])("evorca %s", (command) => {
  it("exits with code 1 and lists the benchmarks for an unknown benchmark", async () => {
    const { code, stderr } = await evorca(command, "--benchmark=nope");

    expect(code).toBe(1);
    expect(stderr).toContain("openrca");
  });

  it("exits with code 1 and lists the benchmarks without --benchmark", async () => {
    const { code, stderr } = await evorca(command, "--scenario=bank");

    expect(code).toBe(1);
    expect(stderr).toContain("openrca");
  });

  it("exits with code 1 and lists the scenarios for an unknown scenario", async () => {
    const { code, stderr } = await evorca(command, "--benchmark=openrca", "--scenario=nope");

    expect(code).toBe(1);
    for (const scenario of ["bank", "telecom", "market-cloudbed-1", "market-cloudbed-2"]) {
      expect(stderr).toContain(scenario);
    }
  });
});
