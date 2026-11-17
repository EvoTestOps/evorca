import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

async function evorca(...args: string[]) {
  const flags = ["--experimental-ffi", "--disable-warning=ExperimentalWarning", "--import", "tsx"];
  return promisify(execFile)(process.execPath, [...flags, "src/main.ts", ...args], {
    cwd: packageDir,
  }).then(
    ({ stderr }) => ({ code: 0, stderr }),
    (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
  );
}

describe("evorca", () => {
  it("exits with code 1 and only its own message when stdin is not a terminal", async () => {
    const { code, stderr } = await evorca();

    expect(code).toBe(1);
    expect(stderr).toBe("evorca needs an interactive terminal.\n");
  });

  it("exits with code 1 and lists the commands for an unknown command", async () => {
    const { code, stderr } = await evorca("nope", "--benchmark=openrca");

    expect(code).toBe(1);
    expect(stderr).toContain("fetch");
    expect(stderr).toContain("reproduce");
    expect(stderr).toContain("evaluate");
  });
});

describe("evorca evaluate", () => {
  it("exits with code 1 and lists the agents for an unknown agent", async () => {
    const { code, stderr } = await evorca(
      "evaluate",
      "--benchmark=openrca",
      "--scenario=telecom",
      "--agent=nope",
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Unknown agent: nope");
    expect(stderr).toContain("random");
  });

  it("exits with code 1 and lists the agents without --agent", async () => {
    const { code, stderr } = await evorca("evaluate", "--benchmark=openrca", "--scenario=telecom");

    expect(code).toBe(1);
    expect(stderr).toContain("random");
  });

  it.each([
    ["--jobs=0", "--jobs must be a positive integer"],
    ["--jobs=two", "--jobs must be a positive integer"],
    ["--rows=0,,7", "--rows must list row numbers"],
    ["--rows=-1", "--rows must list row numbers"],
  ])("exits with code 1 for %s", async (flag, message) => {
    const { code, stderr } = await evorca(
      "evaluate",
      "--benchmark=openrca",
      "--agent=random",
      flag,
    );

    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it.each([
    ["--effort=extreme", "Unknown effort: extreme"],
    ["--model=claude-nope", "Unknown model: claude-nope"],
    ["--budget-usd=0", "--budget-usd must be a positive number"],
    ["--task-budget-usd=two", "--task-budget-usd must be a positive number"],
  ])("exits with code 1 for %s", async (flag, message) => {
    const { code, stderr } = await evorca(
      "evaluate",
      "--benchmark=openrca",
      "--agent=random",
      flag,
    );

    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it("exits with code 1 for a model flag on an agent that calls no model", async () => {
    const { code, stderr } = await evorca(
      "evaluate",
      "--benchmark=openrca",
      "--scenario=telecom",
      "--agent=random",
      "--budget-usd=5",
    );

    expect(code).toBe(1);
    expect(stderr).toContain("apply only to an agent that calls a model, and random does not");
  });

  it("exits with code 1 for a run ID that is not one", async () => {
    const { code, stderr } = await evorca("evaluate", "--benchmark=openrca", "--resume=../x");

    expect(code).toBe(1);
    expect(stderr).toContain("--resume takes a run ID");
  });
});

describe.each(["fetch", "reproduce", "evaluate"])("evorca %s", (command) => {
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
