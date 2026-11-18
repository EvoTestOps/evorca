import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

async function evorca(...args: string[]) {
  return evorcaWith({}, ...args);
}

async function evorcaWith(env: Record<string, string>, ...args: string[]) {
  const flags = ["--experimental-ffi", "--disable-warning=ExperimentalWarning", "--import", "tsx"];
  return promisify(execFile)(process.execPath, [...flags, "src/main.ts", ...args], {
    cwd: packageDir,
    env: { ...process.env, ...env },
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
    ["--runs=0", "--runs must be a positive integer"],
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

  it.each(["http://api.example.com", "ftp://127.0.0.1", "not a url"])(
    "exits with code 1 for EVORCA_UPSTREAM_URL=%s, which could send the key in clear",
    async (url) => {
      const env = { EVORCA_UPSTREAM_URL: url };
      const { code, stderr } = await evorcaWith(
        env,
        "evaluate",
        "--benchmark=openrca",
        "--agent=random",
      );

      expect(code).toBe(1);
      expect(stderr).toContain("EVORCA_UPSTREAM_URL must be an https URL");
    },
  );

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

  it("exits with code 1 for --runs on a resumed run, which keeps its number of runs", async () => {
    const { code, stderr } = await evorca(
      "evaluate",
      "--benchmark=openrca",
      "--resume=20261117T121537Z-random-1",
      "--runs=5",
    );

    expect(code).toBe(1);
    expect(stderr).toContain("--runs starts new runs");
  });
});

describe("evorca fetch", () => {
  it("exits with code 1 and lists the archives and their sizes for an --archive that is none of them", async () => {
    const downloads = await mkdtemp(join(tmpdir(), "evorca-downloads-"));
    onTestFinished(() => rm(downloads, { recursive: true }));
    const archive = join(downloads, "Telecom.zip");
    await writeFile(archive, "not the archive");

    const { code, stderr } = await evorca(
      "fetch",
      "--benchmark=openrca",
      "--scenario=telecom",
      `--archive=${archive}`,
    );

    expect(code).toBe(1);
    expect(stderr).toBe(
      `${archive} has 15 bytes, but the OpenRCA archives are Bank.zip (2829139841 bytes), ` +
        "Telecom.zip (3071992930 bytes), and Market.zip (2865427796 bytes)\n",
    );
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
