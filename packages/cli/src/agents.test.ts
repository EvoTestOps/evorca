import { describe, expect, it } from "vitest";
import { dockerRunArgs, outcomeOf, type Exit, type TaskContainer } from "./agents.js";

const dataDir = "/repo/data/benchmarks/openrca";
const taskDir = "/repo/data/runs/openrca/telecom/20261117T120000Z-random/tasks/007";
const container: TaskContainer = {
  name: "evorca-20261117T120000Z-random-telecom-7",
  image: "sha256:0123",
  agent: { seesCandidates: true, needsTelemetry: false, timeoutSeconds: 60 },
  taskDir,
  dataDir,
  scenario: "telecom",
  seed: 42,
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
    expect(valuesOf(args, "--env")).toEqual(["EVORCA_SEED=42"]);
    expect(args.at(-1)).toBe("sha256:0123");
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
