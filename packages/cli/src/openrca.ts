/**
 * What `evorca reproduce --benchmark=openrca` and `evorca evaluate
 * --benchmark=openrca` do and print. `reproduce` reads the answer keys that the
 * command fetches before it scores. `evaluate` runs an agent on each task in a
 * Docker container, scores the answers, and keeps each run on disk.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Diagnosis } from "@evorca/core";
import {
  openRcaCandidates,
  readTasks,
  writePredictions,
  type OpenRcaScenario,
  type TaskIndex,
} from "@evorca/openrca";
import {
  evaluatorVersions,
  pinnedInputs,
  reproduceArchive,
  scoreWithOfficialEvaluator,
  summarize,
  type Mismatch,
  type ScoredRow,
  type Stage,
  type Summary,
} from "@evorca/openrca/scoring";
import {
  agents,
  dockerVersions,
  ensureImage,
  outcomeOf,
  runContainer,
  type Agent,
  type AgentName,
  type Outcome,
} from "./agents.js";

const run = promisify(execFile);

/**
 * Reproduces the archive scores of `scenarios`, prints the report, and returns
 * whether every score matches.
 *
 * @throws Error if `evaluatorVersions` or `reproduceArchive` fails.
 */
export async function reproduceOpenRca({
  scenarios,
  dataDir,
  cacheDir,
}: {
  readonly scenarios: readonly OpenRcaScenario[];
  readonly dataDir: string;
  readonly cacheDir: string;
}): Promise<boolean> {
  const { uv, python } = await evaluatorVersions(cacheDir);
  const results = await Array.fromAsync(scenarios, async (scenario) => ({
    scenario,
    ...(await reproduceArchive({ scenario, dataDir, cacheDir })),
  }));
  const mismatches = results.flatMap((result) => [
    ...result.published.mismatches,
    ...result.roundTripped.mismatches,
  ]);

  console.log(`OpenRCA ${pinnedInputs.repository} at ${pinnedInputs.commit}`);
  for (const [name, archive] of Object.entries(pinnedInputs.driveArchives)) {
    console.log(`Drive ${name} archive ${archive.driveId}, ${archive.bytes} bytes`);
  }
  for (const [file, sha256] of Object.entries(pinnedInputs.answerKeySha256)) {
    console.log(`sha256 ${sha256}  ${file}`);
  }
  console.log(`node ${process.version}, ${uv}, ${python}`);
  for (const { scenario, tasks, published, roundTripped } of results) {
    const stages = `stage 1 ${matched(published, tasks)}, stage 2 ${matched(roundTripped, tasks)}`;
    console.log(`\n${scenario}: ${tasks} rows, ${stages}`);
    printSummary(summarize(roundTripped.scores));
    for (const mismatch of [...published.mismatches, ...roundTripped.mismatches]) {
      printMismatch(mismatch);
    }
  }
  console.log("\nAll scenarios:");
  printSummary(summarize(results.flatMap((result) => result.roundTripped.scores)));
  console.log(
    mismatches.length === 0
      ? "\nAll scores match the archive."
      : `\n${mismatches.length} mismatches.`,
  );
  return mismatches.length === 0;
}

/** What `run.json` records about the run of one agent on one scenario. */
type RunRecord = {
  readonly runId: string;
  readonly benchmark: "openrca";
  readonly scenario: OpenRcaScenario;
  readonly agent: Agent & {
    readonly name: AgentName;
    readonly image: string;
    readonly imageId: string;
  };
  readonly seed: number;
  readonly git: { readonly commit: string; readonly dirty: boolean };
  readonly pinnedInputs: typeof pinnedInputs;
  readonly versions: {
    readonly node: string;
    readonly docker: { readonly client: string; readonly server: string };
  };
  readonly startedAt: string;
  readonly endedAt: string;
  readonly tasks: readonly TaskRecord[];
};

/**
 * What `run.json` records about one task. `exitCode` is null after a timeout or
 * when a signal ended the `docker run` client.
 */
type TaskRecord = {
  readonly row: number;
  readonly taskIndex: TaskIndex;
  readonly outcome: Outcome;
  readonly exitCode: number | null;
  readonly seconds: number;
};

type Setup = Pick<RunRecord, "runId" | "agent" | "seed" | "git" | "versions">;

/**
 * Runs `agent` on every task of `scenarios`, one task at a time, each in its
 * own container. It scores the answers with the official evaluator and prints
 * a line per task and the accuracy per scenario. Each scenario's run lands in
 * `<runsDir>/<scenario>/<run id>/`. Before any task, it prints the problem and
 * returns false if a scenario lacks the data that the agent reads, or if Docker
 * does not answer. Otherwise it returns true.
 *
 * @throws Error if git, an image build, a container start, or the evaluator fails.
 */
export async function evaluateOpenRca({
  scenarios,
  agent: name,
  seed,
  dataDir,
  cacheDir,
  runsDir,
  agentsDir,
}: {
  readonly scenarios: readonly OpenRcaScenario[];
  readonly agent: AgentName;
  readonly seed: number;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly runsDir: string;
  readonly agentsDir: string;
}): Promise<boolean> {
  const agent: Agent = agents[name];
  const needs = (scenario: OpenRcaScenario) => [
    join(dataDir, scenario, "query.csv"),
    ...(agent.needsTelemetry ? [join(dataDir, scenario, "telemetry")] : []),
  ];
  const missing = scenarios.filter(
    (scenario) => !needs(scenario).every((path) => existsSync(path)),
  );
  if (missing.length > 0) {
    const flags = missing.map((scenario) => `--scenario=${scenario}`).join(" ");
    console.error(`Missing the data of ${missing.join(", ")}. Fetch it with:`);
    console.error(`  pnpm evorca fetch --benchmark=openrca ${flags}`);
    return false;
  }
  const docker = await dockerVersions();
  if (docker === undefined) {
    console.error("Docker is not running. Start Docker Desktop and try again.");
    return false;
  }

  const image = await ensureImage(name, agentsDir);
  const git = await gitState(agentsDir);
  const setup: Setup = {
    runId: `${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${name}`,
    agent: { name, ...agent, image: image.tag, imageId: image.id },
    seed,
    git,
    versions: { node: process.version, docker },
  };
  console.log(`Agent ${name}, image ${image.tag}, ${image.id}`);
  console.log(`Seed ${seed}. Set EVORCA_SEED=${seed} to repeat this run.`);
  console.log(`git ${git.commit}${git.dirty ? " with uncommitted changes" : ""}`);
  console.log(`node ${process.version}, docker ${docker.client}, daemon ${docker.server}`);
  const scores: ScoredRow[] = [];
  for (const scenario of scenarios) {
    scores.push(...(await evaluateScenario(scenario, setup, { dataDir, cacheDir, runsDir })));
  }
  if (scenarios.length > 1) {
    console.log("\nAll scenarios:");
    printSummary(summarize(scores));
  }
  return true;
}

async function evaluateScenario(
  scenario: OpenRcaScenario,
  { runId, ...setup }: Setup,
  {
    dataDir,
    cacheDir,
    runsDir,
  }: { readonly dataDir: string; readonly cacheDir: string; readonly runsDir: string },
): Promise<ScoredRow[]> {
  const tasks = await readTasks(scenario, dataDir);
  const runDir = join(runsDir, scenario, runId);
  console.log(
    `\n${scenario}: ${tasks.length} tasks, run folder ${relative(process.cwd(), runDir)}`,
  );
  const startedAt = new Date().toISOString();
  const records: TaskRecord[] = [];
  const diagnoses = new Map<number, Diagnosis>();
  for (const task of tasks) {
    const taskDir = join(runDir, "tasks", String(task.row).padStart(3, "0"));
    await mkdir(taskDir, { recursive: true });
    const candidates = setup.agent.seesCandidates
      ? { candidates: openRcaCandidates[scenario] }
      : {};
    await writeFile(join(taskDir, "task.json"), json({ ...task, ...candidates }));
    const started = performance.now();
    const exit = await runContainer(
      {
        name: `evorca-${runId}-${scenario}-${task.row}`,
        image: setup.agent.imageId,
        agent: setup.agent,
        taskDir,
        dataDir,
        scenario,
        seed: setup.seed,
      },
      join(taskDir, "log.txt"),
    );
    const seconds = Math.round(performance.now() - started) / 1000;
    const prediction = await readFile(join(taskDir, "out", "prediction.json"), "utf8").catch(
      () => undefined,
    );
    const { outcome, diagnosis } = outcomeOf(exit, prediction);
    diagnoses.set(task.row, diagnosis);
    const exitCode = exit.kind === "exited" ? exit.code : null;
    records.push({ row: task.row, taskIndex: task.taskIndex, outcome, exitCode, seconds });
    const progress = `${records.length}/${tasks.length} ${task.taskIndex}`;
    console.log(`${scenario} ${progress} ${outcome} ${seconds.toFixed(2)} s`);
  }
  const endedAt = new Date().toISOString();

  const predictionsPath = join(runDir, "predictions.csv");
  await writeFile(predictionsPath, writePredictions(tasks, diagnoses));
  const record: RunRecord = {
    runId,
    benchmark: "openrca",
    scenario,
    ...setup,
    pinnedInputs,
    startedAt,
    endedAt,
    tasks: records,
  };
  await writeFile(join(runDir, "run.json"), json(record));
  const scores = await scoreWithOfficialEvaluator({ predictionsPath, scenario, dataDir, cacheDir });
  const summary = summarize(scores);
  await writeFile(join(runDir, "scores.json"), json({ summary, scores }));

  const outcomes = Map.groupBy(records, (task) => task.outcome);
  const counts = [...outcomes].map(([outcome, tasks]) => `${tasks.length} ${outcome}`);
  console.log(`\n${scenario}: ${counts.join(", ")}`);
  printSummary(summary);
  return scores;
}

async function gitState(dir: string): Promise<RunRecord["git"]> {
  const git = async (...args: string[]) => (await run("git", ["-C", dir, ...args])).stdout.trim();
  return {
    commit: await git("rev-parse", "HEAD"),
    dirty: (await git("status", "--porcelain")) !== "",
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function matched(stage: Stage, tasks: number): string {
  return `${stage.scores.length - stage.mismatches.length}/${tasks} match`;
}

function printSummary(summary: Summary) {
  for (const [level, { tasks, strict, partial }] of Object.entries(summary)) {
    const counts = `${level.padEnd(7)} ${String(tasks).padStart(4)} tasks`;
    console.log(`  ${counts}  strict ${percent(strict)}  partial ${percent(partial)}`);
  }
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`.padStart(7);
}

function printMismatch({ stage, row, taskIndex, score, archived, prediction }: Mismatch) {
  const scores = `archive ${archived.score}, ours ${score}`;
  console.log(`  mismatch stage ${stage} row ${row} ${taskIndex}: ${scores}`);
  console.log(`    archive prediction: ${JSON.stringify(archived.prediction)}`);
  console.log(`    our prediction:     ${JSON.stringify(prediction)}`);
}
