import { afterEach, describe, expect, it } from "vitest";
import {
  agents,
  dockerRunArgs,
  outcomeOf,
  type Exit,
  type ModelAccess,
  type TaskContainer,
} from "./agents.js";

const dataDir = "/repo/data/benchmarks/openrca";
const taskDir = "/repo/data/runs/openrca/telecom/20261117T120000Z-random/tasks/007";
const container: TaskContainer = {
  runId: "20261117T120000Z-random",
  name: "evorca-20261117T120000Z-random-telecom-7",
  image: "sha256:0123",
  agent: agents.random,
  taskDir,
  dataDir,
  scenario: "telecom",
  seed: 42,
  model: undefined,
};
const model: ModelAccess = {
  network: "evorca-20261117T120000Z-react-telecom-7",
  baseUrl: "http://evorca-proxy:8080",
  token: "evorca-task-token",
  model: "claude-sonnet-5",
  effort: "high",
  taskBudgetUsd: 2,
};

function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));
}

describe("dockerRunArgs", () => {
  it.each([false, true])("isolates the container when needsTelemetry is %s", (needsTelemetry) => {
    const args = dockerRunArgs({ ...container, agent: { ...container.agent, needsTelemetry } });

    expect(args).toContain("--read-only");
    expect(valuesOf(args, "--network")).toEqual(["none"]);
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(valuesOf(args, "--user")).toEqual(["65534:65534"]);
    expect(valuesOf(args, "--env")).toEqual(["EVORCA_SEED=42", "EVORCA_TASK_TIMEOUT_SECONDS=60"]);
    expect(valuesOf(args, "--label")).toEqual(["evorca.run=20261117T120000Z-random"]);
    expect(args.at(-1)).toBe("sha256:0123");
  });

  it("gives the random agent 1 GiB of memory, a 64 MiB /tmp, one CPU, and 128 processes", () => {
    const args = dockerRunArgs(container);

    expect(valuesOf(args, "--memory")).toEqual(["1024m"]);
    expect(valuesOf(args, "--tmpfs")).toEqual(["/tmp:rw,noexec,nosuid,size=64m"]);
    expect(valuesOf(args, "--cpus")).toEqual(["1"]);
    expect(valuesOf(args, "--pids-limit")).toEqual(["128"]);
  });

  it("applies the limits of the agent's resources", () => {
    const resources = { memoryMiB: 3072, tmpMiB: 1536, cpus: 2, pids: 256 };
    const args = dockerRunArgs({ ...container, agent: { ...container.agent, resources } });

    expect(valuesOf(args, "--memory")).toEqual(["3072m"]);
    expect(valuesOf(args, "--tmpfs")).toEqual(["/tmp:rw,noexec,nosuid,size=1536m"]);
    expect(valuesOf(args, "--cpus")).toEqual(["2"]);
    expect(valuesOf(args, "--pids-limit")).toEqual(["256"]);
  });

  it("mounts the task read-only and the out folder writable, without telemetry", () => {
    expect(valuesOf(dockerRunArgs(container), "--mount")).toEqual([
      `type=bind,src=${taskDir}/task.json,dst=/task.json,readonly`,
      `type=bind,src=${taskDir}/out,dst=/out`,
    ]);
  });

  it("mounts only the scenario's telemetry folder at /data, read-only", () => {
    const agent = { ...container.agent, needsTelemetry: true };
    const mounts = valuesOf(dockerRunArgs({ ...container, agent }), "--mount");

    expect(mounts).toEqual([
      `type=bind,src=${taskDir}/task.json,dst=/task.json,readonly`,
      `type=bind,src=${taskDir}/out,dst=/out`,
      `type=bind,src=${dataDir}/telecom/telemetry,dst=/data,readonly`,
    ]);
    const sources = mounts.map((mount) => /src=([^,]*)/.exec(mount)?.[1]);
    expect(sources).not.toContain(`${dataDir}/telecom`);
    expect(sources).not.toContain(dataDir);
  });

  describe("with model access", () => {
    const realKey = process.env.ANTHROPIC_API_KEY;
    afterEach(() => {
      if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = realKey;
    });

    it("joins the task's network and gets the proxy, the token, and the run's model", () => {
      const args = dockerRunArgs({ ...container, model });

      expect(valuesOf(args, "--network")).toEqual(["evorca-20261117T120000Z-react-telecom-7"]);
      expect(valuesOf(args, "--env")).toEqual([
        "EVORCA_SEED=42",
        "EVORCA_TASK_TIMEOUT_SECONDS=60",
        "ANTHROPIC_BASE_URL=http://evorca-proxy:8080",
        "ANTHROPIC_API_KEY=evorca-task-token",
        "EVORCA_MODEL=claude-sonnet-5",
        "EVORCA_EFFORT=high",
        "EVORCA_TASK_BUDGET_USD=2",
      ]);
      expect(args).toContain("--read-only");
      expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
      expect(valuesOf(args, "--user")).toEqual(["65534:65534"]);
    });

    it("tells the react agent its one-hour timeout", () => {
      const args = dockerRunArgs({ ...container, agent: agents.react, model });

      expect(valuesOf(args, "--env")).toContain("EVORCA_TASK_TIMEOUT_SECONDS=3600");
    });

    it("never passes the real API key, not even by name", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-real-key-sentinel";
      const args = dockerRunArgs({ ...container, model });

      expect(args.join(" ")).not.toContain("sk-ant-real-key-sentinel");
      expect(args).not.toContain("ANTHROPIC_API_KEY");
      expect(args.filter((arg) => arg.startsWith("ANTHROPIC_API_KEY="))).toEqual([
        "ANTHROPIC_API_KEY=evorca-task-token",
      ]);
    });
  });
});

describe("outcomeOf", () => {
  const exited: Exit = { kind: "exited", code: 0 };
  const prediction = '{"1": {"root cause component": "docker_003"}}';

  it("scores the prediction of a container that exits with code 0", () => {
    expect(outcomeOf(exited, prediction)).toEqual({
      outcome: "answered",
      diagnosis: [{ occurredAt: undefined, component: "docker_003", reason: undefined }],
    });
  });

  it.each<[string, Exit, string | undefined]>([
    ["no-prediction", exited, undefined],
    ["invalid-prediction", exited, "docker_003"],
    ["nonzero-exit", { kind: "exited", code: 1 }, prediction],
    ["nonzero-exit", { kind: "exited", code: null }, prediction],
    ["timeout", { kind: "timeout" }, prediction],
  ])("scores the empty prediction for %s", (outcome, exit, text) => {
    expect(outcomeOf(exit, text)).toEqual({ outcome, diagnosis: [] });
  });
});
