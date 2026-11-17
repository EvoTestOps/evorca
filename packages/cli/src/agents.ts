/**
 * The agents that `evorca evaluate` runs, and the Docker container that runs
 * one OpenRCA task of an agent. The container reads the task at `/task.json`
 * and writes its answer, OpenRCA prediction JSON, to `/out/prediction.json`.
 * It has no network and a read-only root file system. It sees the scenario's
 * telemetry at `/data` only if its agent needs telemetry, and it never sees
 * `query.csv` or `record.csv`, which hold the answers.
 *
 * @module
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Diagnosis } from "@evorca/core";
import { parsePrediction, type OpenRcaScenario } from "@evorca/openrca";

const run = promisify(execFile);
const containerUser = "65534:65534";

/** The Docker label that holds the run ID on every container that a run starts. */
export const runLabel = "evorca.run";

/**
 * The limits of one task's container: its memory and its `/tmp` folder in MiB,
 * its CPUs, and its processes. `/tmp` lives in memory and counts toward
 * `memoryMiB`.
 */
export type Resources = {
  readonly memoryMiB: number;
  readonly tmpMiB: number;
  readonly cpus: number;
  readonly pids: number;
};

/**
 * How `evorca evaluate` runs an agent. `seesCandidates` adds the scenario's
 * candidate components and reasons to `/task.json`. `needsTelemetry` mounts the
 * scenario's telemetry at `/data`. `timeoutSeconds` bounds each task, and
 * `resources` limits its container. `jobs` is how many tasks run at once
 * unless `--jobs` says otherwise.
 */
export type Agent = {
  readonly seesCandidates: boolean;
  readonly needsTelemetry: boolean;
  readonly timeoutSeconds: number;
  readonly resources: Resources;
  readonly jobs: number;
};

/** The agents by name. Each agent's image builds from `agents/<name>/` at the repository root. */
export const agents = {
  random: {
    seesCandidates: true,
    needsTelemetry: false,
    timeoutSeconds: 60,
    resources: { memoryMiB: 1024, tmpMiB: 64, cpus: 1, pids: 128 },
    jobs: 1,
  },
} satisfies Record<string, Agent>;

/** The name of an agent, such as `random`. */
export type AgentName = keyof typeof agents;

/** An agent's image: a tag that names the hash of the agent's folder, and the Docker image ID. */
export type AgentImage = { readonly tag: string; readonly id: string };

/**
 * Returns the image of the agent in `<agentsDir>/<name>/`. It builds the image
 * unless an image with the folder's hash exists. The hash covers every file in
 * the folder outside `node_modules`.
 *
 * @throws Error if `docker build` fails.
 */
export async function ensureImage(name: AgentName, agentsDir: string): Promise<AgentImage> {
  const dir = join(agentsDir, name);
  const tag = `evorca-agent-${name}:${(await hashFolder(dir)).slice(0, 12)}`;
  const existing = await run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]).catch(
    () => undefined,
  );
  const built = existing ?? (await run("docker", ["build", "--quiet", "--tag", tag, dir]));
  return { tag, id: built.stdout.trim() };
}

async function hashFolder(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .filter((file) => !file.split(sep).includes("node_modules"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const contents = await readFile(join(dir, file));
    hash.update(`${file}\0${contents.length}\0`).update(contents);
  }
  return hash.digest("hex");
}

/**
 * Returns the versions of the Docker client and the Docker daemon, or undefined
 * if the daemon does not answer.
 */
export async function dockerVersions(): Promise<
  { readonly client: string; readonly server: string } | undefined
> {
  const format = "{{.Client.Version}} {{.Server.Version}}";
  const versions = await run("docker", ["version", "--format", format]).catch(() => undefined);
  if (versions === undefined) return undefined;
  const [client = "", server = ""] = versions.stdout.trim().split(" ");
  return { client, server };
}

/**
 * Returns the memory of the Docker daemon's machine in MiB, which on Docker
 * Desktop is the memory of its virtual machine.
 *
 * @throws Error if the daemon does not answer.
 */
export async function dockerMemoryMiB(): Promise<number> {
  const info = await run("docker", ["info", "--format", "{{.MemTotal}}"]);
  return Math.floor(Number(info.stdout.trim()) / 2 ** 20);
}

/**
 * One task's container. `runId` labels it, `image` is an image ID, and
 * `taskDir` holds the task's `task.json`. `runContainer` creates the task's
 * `out/` folder in `taskDir`.
 */
export type TaskContainer = {
  readonly runId: string;
  readonly name: string;
  readonly image: string;
  readonly agent: Pick<Agent, "needsTelemetry" | "timeoutSeconds" | "resources">;
  readonly taskDir: string;
  readonly dataDir: string;
  readonly scenario: OpenRcaScenario;
  readonly seed: number;
};

/**
 * Returns the arguments of `docker run` for one task. The container runs as an
 * unprivileged user with no network, no capabilities, a read-only root file
 * system, and the agent's limits on memory, `/tmp`, CPU, and processes. It gets
 * `task.json` at `/task.json`, read-only, and `out/` at `/out`, writable. If
 * the agent needs telemetry, it gets `<dataDir>/<scenario>/telemetry/` at
 * `/data`, read-only. The seed is in `EVORCA_SEED`, and the `evorca.run` label
 * holds the run ID.
 */
export function dockerRunArgs(container: TaskContainer): string[] {
  const { runId, name, image, agent, taskDir, dataDir, scenario, seed } = container;
  const { memoryMiB, tmpMiB, cpus, pids } = agent.resources;
  const telemetry = agent.needsTelemetry
    ? ["--mount", `type=bind,src=${join(dataDir, scenario, "telemetry")},dst=/data,readonly`]
    : [];
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    `${runLabel}=${runId}`,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${tmpMiB}m`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    containerUser,
    "--memory",
    `${memoryMiB}m`,
    "--cpus",
    String(cpus),
    "--pids-limit",
    String(pids),
    "--mount",
    `type=bind,src=${join(taskDir, "task.json")},dst=/task.json,readonly`,
    "--mount",
    `type=bind,src=${join(taskDir, "out")},dst=/out`,
    ...telemetry,
    "--env",
    `EVORCA_SEED=${seed}`,
    image,
  ];
}

/**
 * How a task's container ended: it exited, with a null code if a signal ended
 * the `docker run` client, or the runner killed it at the agent's timeout.
 */
export type Exit =
  { readonly kind: "exited"; readonly code: number | null } | { readonly kind: "timeout" };

/**
 * Runs one task's container, writes its stdout and stderr to `logPath`, and
 * returns how it ended. It first creates the task's `out/` folder, writable by
 * the container's user, and it kills the container after the agent's timeout.
 *
 * @throws Error with the log if Docker cannot start the container, which
 *   `docker run` reports with exit code 125.
 */
export async function runContainer(container: TaskContainer, logPath: string): Promise<Exit> {
  const outDir = join(container.taskDir, "out");
  await mkdir(outDir, { recursive: true });
  // The container's user does not own the folder on the host.
  await chmod(outDir, 0o777);
  await using log = await open(logPath, "w");
  // Detached, so a ctrl+c in the terminal reaches evorca alone, which then removes the containers.
  const child = spawn("docker", dockerRunArgs(container), {
    stdio: ["ignore", log.fd, log.fd],
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    execFile("docker", ["kill", container.name], () => {});
  }, container.agent.timeoutSeconds * 1000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve).once("error", reject);
  }).finally(() => clearTimeout(timer));
  if (timedOut) return { kind: "timeout" };
  if (code === 125) throw new Error(`docker run failed: ${await readFile(logPath, "utf8")}`);
  return { kind: "exited", code };
}

/**
 * What became of one task. Only `answered` scores the agent's prediction. Every
 * other outcome scores the empty prediction `{}`.
 */
export type Outcome =
  "answered" | "no-prediction" | "invalid-prediction" | "nonzero-exit" | "timeout";

/**
 * Removes every container that carries the run's label, running or not. A run
 * calls it when it stops, and a resumed run calls it before its first task.
 */
export async function removeRunContainers(runId: string): Promise<void> {
  const filter = `label=${runLabel}=${runId}`;
  const listed = await run("docker", ["ps", "--all", "--quiet", "--filter", filter]);
  const ids = listed.stdout.split("\n").filter((id) => id !== "");
  if (ids.length > 0) await run("docker", ["rm", "--force", ...ids]);
}

/**
 * Returns a task's outcome and the diagnosis to score, from how its container
 * ended and the text of `/out/prediction.json`, undefined if the file is missing.
 */
export function outcomeOf(
  exit: Exit,
  prediction: string | undefined,
): { readonly outcome: Outcome; readonly diagnosis: Diagnosis } {
  if (exit.kind === "timeout") return { outcome: "timeout", diagnosis: [] };
  if (exit.code !== 0) return { outcome: "nonzero-exit", diagnosis: [] };
  if (prediction === undefined) return { outcome: "no-prediction", diagnosis: [] };
  const diagnosis = parsePrediction(prediction);
  if (diagnosis === undefined) return { outcome: "invalid-prediction", diagnosis: [] };
  return { outcome: "answered", diagnosis };
}
