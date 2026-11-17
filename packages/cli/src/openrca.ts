/**
 * What `evorca reproduce --benchmark=openrca` and `evorca evaluate
 * --benchmark=openrca` do and print. `reproduce` reads the answer keys that the
 * command fetches before it scores. `evaluate` runs an agent on each task in a
 * Docker container, scores the answers, and keeps each run on disk.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Diagnosis } from "@evorca/core";
import {
  openRcaCandidates,
  parsePrediction,
  readTasks,
  writePredictions,
  type OpenRcaScenario,
  type OpenRcaTask,
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
  dockerMemoryMiB,
  dockerVersions,
  ensureImage,
  outcomeOf,
  removeRunContainers,
  runContainer,
  type AgentName,
  type Exit,
} from "./agents.js";
import {
  addUsage,
  models,
  noUsage,
  priceTable,
  usageOfLog,
  type Effort,
  type ModelId,
  type ModelUsage,
} from "./models.js";
import { startModelProxy, type ModelProxy } from "./proxy.js";
import { proxyUrl, removeRunNetworks, startRelay, type Relay } from "./relay.js";
import {
  conflicts,
  readRuns,
  runPool,
  tasksToRun,
  writeJson,
  type AgentRecord,
  type GitState,
  type ModelSettings,
  type RunRecord,
  type TaskRecord,
} from "./runs.js";

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

/**
 * What `evorca evaluate` asks for. `resume` names a run to continue. A setting
 * that is undefined comes from that run, or else from its default: the agent's
 * `jobs`, every row, a random seed, `claude-sonnet-5` at the model's default
 * effort, a $50 run budget, and a $2 task budget. `apiKey` is the real API key,
 * and `upstreamUrl` is the API that the model proxy forwards to.
 */
export type EvaluateRequest = {
  readonly scenarios: readonly OpenRcaScenario[];
  readonly agent: AgentName | undefined;
  readonly seed: number | undefined;
  readonly rows: readonly number[] | undefined;
  readonly jobs: number | undefined;
  readonly resume: string | undefined;
  readonly model: ModelId | undefined;
  readonly effort: Effort | undefined;
  readonly budgetUsd: number | undefined;
  readonly taskBudgetUsd: number | undefined;
  readonly apiKey: string | undefined;
  readonly upstreamUrl: string;
};

type Dirs = {
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly runsDir: string;
  readonly agentsDir: string;
};

/** One scenario of a run: its tasks, the rows that the run covers, and its folder. */
type ScenarioPlan = {
  readonly scenario: OpenRcaScenario;
  readonly tasks: readonly OpenRcaTask[];
  readonly selected: readonly OpenRcaTask[];
  readonly runDir: string;
  readonly record: RunRecord;
};

/**
 * What the tasks of one session of a run share: how many run at once, where
 * the data and the evaluator live, the signal that stops the session, and the
 * model proxy and relay if the agent calls a model.
 */
type Session = {
  readonly jobs: number;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly signal: AbortSignal;
  readonly model: ModelSession | undefined;
};

type ModelSession = {
  readonly settings: ModelSettings;
  readonly budgetUsd: number;
  readonly proxy: ModelProxy;
  readonly relay: Relay;
};

const defaultModel: ModelId = "claude-sonnet-5";
const defaultBudgetUsd = 50;
const defaultTaskBudgetUsd = 2;

/**
 * Runs an agent on the tasks of `scenarios`, `jobs` tasks at a time, each in
 * its own container, or continues the run that `resume` names. It scores the
 * answers with the official evaluator and prints a line per task and the
 * accuracy per scenario. Each scenario's run lands in
 * `<runsDir>/<scenario>/<run id>/`, and its `run.json` is rewritten after every
 * task. A resumed run skips the tasks that have an outcome.
 *
 * If the agent calls a model, it starts the model proxy and the relay first.
 * Once the run's model budget is spent, each task that has not started gets
 * the outcome `budget-exhausted`.
 *
 * Before any task, it prints the problem and returns false if a model flag is
 * given for an agent that calls no model, if an agent that calls a model has no
 * API key, if the run to resume is missing or has other settings, if a row does
 * not exist, if a scenario lacks the data that the agent reads, if Docker does
 * not answer, or if the relay cannot reach the proxy. Otherwise it returns true.
 *
 * On SIGINT or SIGTERM, it removes the run's containers and networks and
 * exits, and the run can resume.
 *
 * @throws Error if git, an image build, a container start, or the evaluator fails.
 */
export async function evaluateOpenRca(request: EvaluateRequest & Dirs): Promise<boolean> {
  const { dataDir, cacheDir, runsDir, agentsDir } = request;
  const resumed =
    request.resume === undefined
      ? undefined
      : await readRuns(runsDir, request.resume, request.scenarios);
  if (resumed?.size === 0) {
    console.error(`No run ${request.resume} in ${relative(process.cwd(), runsDir)}.`);
    return false;
  }
  const recorded = resumed?.values().next().value;
  const name = recorded?.agent.name ?? request.agent;
  if (name === undefined) throw new Error("evaluateOpenRca needs an agent or a run to resume.");
  const scenarios = resumed === undefined ? request.scenarios : [...resumed.keys()];
  const { jobs: defaultJobs, ...agent } = agents[name];

  const modelFlags = [request.model, request.effort, request.budgetUsd, request.taskBudgetUsd];
  if (!agent.needsModel && modelFlags.some((flag) => flag !== undefined)) {
    const flags = "--model, --effort, --budget-usd, and --task-budget-usd";
    console.error(`${flags} apply only to an agent that calls a model, and ${name} does not.`);
    return false;
  }
  if (agent.needsModel && !request.apiKey) {
    console.error(`The ${name} agent calls a model, so evorca evaluate needs ANTHROPIC_API_KEY.`);
    console.error("Put the key in .env at the repository root: ANTHROPIC_API_KEY=<key>");
    return false;
  }
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
  const tasks = new Map<OpenRcaScenario, OpenRcaTask[]>();
  for (const scenario of scenarios) tasks.set(scenario, await readTasks(scenario, dataDir));
  const rows = request.rows ?? recorded?.rows ?? null;
  for (const [scenario, scenarioTasks] of tasks) {
    const unknown = rows?.filter((row) => row >= scenarioTasks.length) ?? [];
    if (unknown.length > 0) {
      const range = `rows 0 to ${scenarioTasks.length - 1}`;
      console.error(`${scenario} has no row ${unknown.join(", ")}. Its tasks are ${range}.`);
      return false;
    }
  }
  const docker = await dockerVersions();
  if (docker === undefined) {
    console.error("Docker is not running. Start Docker Desktop and try again.");
    return false;
  }

  const image = await ensureImage(name, agentsDir);
  const agentRecord: AgentRecord = { name, ...agent, image: image.tag, imageId: image.id };
  const modelId = request.model ?? recorded?.model?.id ?? defaultModel;
  const model: ModelSettings | null = agent.needsModel
    ? {
        id: modelId,
        effort: request.effort ?? recorded?.model?.effort ?? models[modelId].defaultEffort,
        taskBudgetUsd:
          request.taskBudgetUsd ?? recorded?.model?.taskBudgetUsd ?? defaultTaskBudgetUsd,
        upstreamUrl: request.upstreamUrl,
        prices: {
          table: priceTable.id,
          source: priceTable.source,
          checkedAt: priceTable.checkedAt,
          usdPerMTok: models[modelId].usdPerMTok,
        },
      }
    : null;
  if (recorded !== undefined) {
    const problems = conflicts(recorded, { agent: agentRecord, seed: request.seed, rows, model });
    if (problems.length > 0) {
      console.error(`Run ${recorded.runId} cannot resume with other settings:`);
      for (const problem of problems) console.error(`  ${problem}`);
      return false;
    }
  }
  const budgetUsd = agent.needsModel
    ? (request.budgetUsd ?? recorded?.budgetUsd ?? defaultBudgetUsd)
    : null;
  const seed = recorded?.seed ?? request.seed ?? randomInt(2 ** 32);
  const jobs = request.jobs ?? recorded?.jobs ?? defaultJobs;
  const runId = recorded?.runId ?? `${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${name}`;
  const git = await gitState(agentsDir);
  const versions = { node: process.version, docker };
  console.log(`Agent ${name}, image ${image.tag}, ${image.id}`);
  console.log(`Seed ${seed}. Set EVORCA_SEED=${seed} to repeat this run.`);
  console.log(`git ${git.commit}${git.dirty ? " with uncommitted changes" : ""}`);
  console.log(`node ${process.version}, docker ${docker.client}, daemon ${docker.server}`);
  if (model !== null) {
    const budgets = `$${budgetUsd} for the run, $${model.taskBudgetUsd} per task`;
    console.log(`Model ${model.id}, effort ${model.effort}, ${budgets}, via ${model.upstreamUrl}`);
  }
  const pace = `${jobs} ${jobs === 1 ? "task" : "tasks"} at a time`;
  console.log(`${recorded === undefined ? "Run" : "Resuming run"} ${runId}, ${pace}.`);
  const memoryMiB = await dockerMemoryMiB();
  if (jobs * agent.resources.memoryMiB > memoryMiB) {
    const asked = `${jobs} tasks at ${agent.resources.memoryMiB} MiB`;
    console.log(`Warning: ${asked} need more than Docker's ${memoryMiB} MiB of memory.`);
  }

  if (recorded !== undefined) await removeRun(runId);
  const startedAt = new Date().toISOString();
  const plans: ScenarioPlan[] = [];
  for (const [scenario, scenarioTasks] of tasks) {
    const runDir = join(runsDir, scenario, runId);
    const previous = resumed?.get(scenario);
    const selected =
      rows === null ? scenarioTasks : scenarioTasks.filter((task) => rows.includes(task.row));
    const abandoned: { row: number; usage: ModelUsage }[] = [];
    for (const task of tasksToRun(selected, previous?.tasks ?? [])) {
      const taskDir = taskDirOf(runDir, task.row);
      const log = await readFile(join(taskDir, "requests.jsonl"), "utf8").catch(() => "");
      if (model !== null && log !== "") {
        abandoned.push({ row: task.row, usage: usageOfLog(log, model.prices.usdPerMTok) });
      }
      await rm(taskDir, { recursive: true, force: true });
    }
    const record: RunRecord =
      previous === undefined
        ? {
            runId,
            benchmark: "openrca",
            scenario,
            agent: agentRecord,
            seed,
            rows,
            model,
            budgetUsd,
            jobs,
            git,
            pinnedInputs,
            versions,
            startedAt,
            resumes: [],
            endedAt: null,
            tasks: [],
            abandoned,
            usage: model === null ? null : totalUsage([], abandoned, model),
          }
        : {
            ...previous,
            budgetUsd,
            jobs,
            resumes: [...previous.resumes, { startedAt, git, versions }],
            endedAt: null,
            abandoned: [...previous.abandoned, ...abandoned],
            usage:
              model === null
                ? null
                : totalUsage(previous.tasks, [...previous.abandoned, ...abandoned], model),
          };
    await mkdir(runDir, { recursive: true });
    await writeJson(join(runDir, "run.json"), record);
    plans.push({ scenario, tasks: scenarioTasks, selected, runDir, record });
  }

  const stop = new AbortController();
  let modelSession: ModelSession | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    stop.abort();
    console.error(
      `\nStopped. Resume with: pnpm evorca evaluate --benchmark=openrca --resume=${runId}`,
    );
    void removeRun(runId).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal).once("SIGTERM", onSignal);
  try {
    if (model !== null && budgetUsd !== null && request.apiKey !== undefined) {
      const spent = plans.reduce(
        (sum, plan) => addUsage(sum, plan.record.usage ?? noUsage, model.prices.usdPerMTok),
        noUsage,
      );
      const proxy = await startModelProxy({
        upstreamUrl: model.upstreamUrl,
        apiKey: request.apiKey,
        model: model.id,
        effort: model.effort,
        budgetUsd,
        spent,
      });
      const relay = await startRelay(runId, proxy.port).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        return undefined;
      });
      modelSession = relay === undefined ? undefined : { settings: model, budgetUsd, proxy, relay };
      if (relay === undefined) {
        await proxy.close();
        return false;
      }
    }
    const session: Session = { jobs, dataDir, cacheDir, signal: stop.signal, model: modelSession };
    const scores: ScoredRow[] = [];
    for (const plan of plans) {
      const scenarioScores = await evaluateScenario(plan, session);
      if (scenarioScores === undefined) return false;
      scores.push(...scenarioScores);
    }
    if (plans.length > 1) {
      console.log("\nAll scenarios:");
      printSummary(summarize(scores));
    }
    if (modelSession !== undefined) {
      const { costUsd, requests } = modelSession.proxy.usage();
      const spent = `$${costUsd.toFixed(4)} of the $${modelSession.budgetUsd} budget`;
      console.log(`\nThe run has spent ${spent} on ${requests} model requests.`);
    }
    return true;
  } finally {
    process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
    if (modelSession !== undefined) await modelSession.proxy.close();
    if (model !== null && !stop.signal.aborted) await removeRun(runId);
  }
}

/**
 * Runs the tasks of one scenario that have no outcome, rewrites `run.json`
 * after each, then scores the run. It returns the scores of the run's rows, or
 * undefined if the session's signal aborts.
 */
async function evaluateScenario(
  { scenario, tasks, selected, runDir, record }: ScenarioPlan,
  session: Session,
): Promise<ScoredRow[] | undefined> {
  const { jobs, dataDir, cacheDir, signal, model } = session;
  const pending = tasksToRun(selected, record.tasks);
  const pendingRows = new Set(pending.map((task) => task.row));
  const records = new Map(
    record.tasks.filter((task) => !pendingRows.has(task.row)).map((task) => [task.row, task]),
  );
  const done = records.size > 0 ? `, ${records.size} done` : "";
  const folder = relative(process.cwd(), runDir);
  const count = `${selected.length} ${selected.length === 1 ? "task" : "tasks"}`;
  console.log(`\n${scenario}: ${count}${done}, run folder ${folder}`);
  let saving = Promise.resolve();
  const save = (endedAt: string | null) => {
    const tasks = [...records.values()].sort((a, b) => a.row - b.row);
    const usage = model === undefined ? null : totalUsage(tasks, record.abandoned, model.settings);
    const snapshot: RunRecord = { ...record, endedAt, tasks, usage };
    saving = saving.then(() => writeJson(join(runDir, "run.json"), snapshot));
    return saving;
  };

  await runPool(
    pending,
    jobs,
    async (task) => {
      const taskRecord = await runTask(task, record, runDir, session).catch((error: unknown) => {
        if (signal.aborted) return undefined;
        throw error;
      });
      if (taskRecord === undefined || signal.aborted) return;
      records.set(task.row, taskRecord);
      const { taskIndex, outcome, seconds, usage } = taskRecord;
      const progress = `${records.size}/${selected.length} ${taskIndex}`;
      const cost =
        model === undefined || usage === null
          ? ""
          : `, $${usage.costUsd.toFixed(4)}, run $${model.proxy.usage().costUsd.toFixed(4)}`;
      console.log(`${scenario} ${progress} ${outcome} ${seconds.toFixed(2)} s${cost}`);
      await save(null);
    },
    signal,
  );
  if (signal.aborted) return undefined;
  await save(new Date().toISOString());

  const diagnoses = new Map<number, Diagnosis>();
  for (const { row, outcome } of records.values()) {
    if (outcome !== "answered") continue;
    const text = await readFile(join(taskDirOf(runDir, row), "out", "prediction.json"), "utf8");
    diagnoses.set(row, parsePrediction(text) ?? []);
  }
  const predictionsPath = join(runDir, "predictions.csv");
  await writeFile(predictionsPath, writePredictions(tasks, diagnoses));
  const rows = new Set(selected.map((task) => task.row));
  const scores = (
    await scoreWithOfficialEvaluator({ predictionsPath, scenario, dataDir, cacheDir })
  ).filter((score) => rows.has(score.row));
  const summary = summarize(scores);
  await writeFile(join(runDir, "scores.json"), json({ summary, scores }));

  const outcomes = Map.groupBy(records.values(), (task) => task.outcome);
  const counts = [...outcomes].map(([outcome, tasks]) => `${tasks.length} ${outcome}`);
  console.log(`\n${scenario}: ${counts.join(", ")}`);
  printSummary(summary);
  if (model !== undefined) {
    const usage = totalUsage([...records.values()], record.abandoned, model.settings);
    console.log(`  model   ${usage.requests} requests, $${usage.costUsd.toFixed(4)}`);
  }
  return scores;
}

/**
 * Runs one task in its own container and returns its record. If the agent
 * calls a model, the task gets a token and a network for the time it runs, or
 * the outcome `budget-exhausted` without a container once the run's budget is
 * spent.
 */
async function runTask(
  task: OpenRcaTask,
  { runId, scenario, agent, seed }: RunRecord,
  runDir: string,
  { dataDir, model }: Session,
): Promise<TaskRecord> {
  const { row, taskIndex } = task;
  if (model !== undefined && model.proxy.usage().costUsd >= model.budgetUsd) {
    const outcome = "budget-exhausted";
    return { row, taskIndex, outcome, exitCode: null, seconds: 0, usage: noUsage };
  }
  const taskDir = taskDirOf(runDir, row);
  await mkdir(taskDir, { recursive: true });
  const candidates = agent.seesCandidates ? { candidates: openRcaCandidates[scenario] } : {};
  await writeFile(join(taskDir, "task.json"), json({ ...task, ...candidates }));
  const name = `evorca-${runId}-${scenario}-${row}`;
  const container = { runId, name, image: agent.imageId, agent, taskDir, dataDir, scenario, seed };
  const logPath = join(taskDir, "log.txt");
  const started = performance.now();
  let exit: Exit;
  let usage: ModelUsage | null = null;
  if (model === undefined) {
    exit = await runContainer({ ...container, model: undefined }, logPath);
  } else {
    const { settings, proxy, relay } = model;
    const token = proxy.openTask({
      budgetUsd: settings.taskBudgetUsd,
      logPath: join(taskDir, "requests.jsonl"),
    });
    await relay.openNetwork(name);
    try {
      const access = {
        network: name,
        baseUrl: proxyUrl,
        token,
        model: settings.id,
        effort: settings.effort,
        taskBudgetUsd: settings.taskBudgetUsd,
      };
      exit = await runContainer({ ...container, model: access }, logPath);
    } finally {
      usage = await proxy.closeTask(token);
      // A network that is still busy stays until the run removes its networks at the end.
      await relay.closeNetwork(name).catch(() => {});
    }
  }
  const seconds = Math.round(performance.now() - started) / 1000;
  const prediction = await readFile(join(taskDir, "out", "prediction.json"), "utf8").catch(
    () => undefined,
  );
  const { outcome } = outcomeOf(exit, prediction);
  const exitCode = exit.kind === "exited" ? exit.code : null;
  return { row, taskIndex, outcome, exitCode, seconds, usage };
}

/** Removes the run's containers, the relay among them, and then its networks. */
async function removeRun(runId: string): Promise<void> {
  await removeRunContainers(runId);
  await removeRunNetworks(runId);
}

function totalUsage(
  tasks: readonly TaskRecord[],
  abandoned: RunRecord["abandoned"],
  { prices }: ModelSettings,
): ModelUsage {
  const usages = [...tasks.map((task) => task.usage ?? noUsage), ...abandoned.map((a) => a.usage)];
  return usages.reduce((sum, usage) => addUsage(sum, usage, prices.usdPerMTok), noUsage);
}

function taskDirOf(runDir: string, row: number): string {
  return join(runDir, "tasks", String(row).padStart(3, "0"));
}

async function gitState(dir: string): Promise<GitState> {
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
