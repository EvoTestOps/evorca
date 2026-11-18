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
  openRcaScenarios,
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
import { reportRuns } from "./report.js";
import {
  conflicts,
  isFinished,
  readRuns,
  runPool,
  taskDirOf,
  tasksToRun,
  writeJson,
  type AgentRecord,
  type GitState,
  type ModelSettings,
  type RunRecord,
  type Series,
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
 * that is undefined comes from that run, or else from its default: one run, the
 * agent's `jobs`, every row, a random seed, `claude-sonnet-5` at the model's
 * default effort, a $50 run budget, and a $2 task budget. `apiKey` is the real
 * API key, and `upstreamUrl` is the API that the model proxy forwards to.
 * `signal` stops the runs.
 */
export type EvaluateRequest = {
  readonly scenarios: readonly OpenRcaScenario[];
  readonly agent: AgentName | undefined;
  readonly runs: number | undefined;
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
  readonly signal: AbortSignal;
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
 * task. A resumed run runs only the tasks that have no outcome or the outcome
 * `budget-exhausted` or `stopped`.
 *
 * With `runs` above 1, it makes that many runs one after another, as a series.
 * Run `k` of series `<id>` has the run ID `<id>-<k>` and the seed of run 1 plus
 * `k - 1`, and it must keep the settings of the other runs of the series.
 * Resuming any run of a series finishes the series: it skips each run that
 * `isFinished` accepts, resumes each other run, and starts each missing run.
 * Then it prints the summary that `reportRuns` prints.
 *
 * If the agent calls a model, it starts the model proxy and the relay first.
 * Once the run's model budget is spent, each task that has not started gets
 * the outcome `budget-exhausted`, and so does each running task that the run's
 * budget cuts short. The budget counts every scenario of the run.
 *
 * Before any task of a run, it prints the problem and returns false if a model
 * flag is given for an agent that calls no model, if an agent that calls a
 * model has no API key, if the run to resume is missing or has other settings,
 * if a run of a series has other settings than the series, if `seed` is not
 * the first seed of the series that it resumes, if a row does not exist, if a
 * scenario lacks the data that the agent reads, if Docker does not answer, or
 * if the relay cannot reach the proxy. It also returns false if the summary of
 * a series finds no finished run of a scenario. Otherwise it returns true.
 *
 * Once `signal` aborts, it starts no more tasks and removes the run's
 * containers. It waits for the model requests in flight, so the run records
 * their cost, then records each running task as `stopped` with what it spent,
 * removes the run's networks, prints the command that resumes the run, and
 * returns false. The run can resume. If `signal` aborts before a run writes
 * its folder, the run does not start, and it returns false.
 *
 * @throws Error if git, an image build, a container start, or the evaluator fails.
 */
export async function evaluateOpenRca(request: EvaluateRequest & Dirs): Promise<boolean> {
  const { runsDir } = request;
  const resumed =
    request.resume === undefined
      ? undefined
      : await readRuns(runsDir, request.resume, request.scenarios);
  const recorded = resumed?.values().next().value;
  const place = recorded?.series;
  if (place === undefined && (request.runs ?? 1) === 1) {
    return (await evaluateRun(request, undefined)) && !request.signal.aborted;
  }

  const name = recorded?.agent.name ?? request.agent;
  if (name === undefined) throw new Error("evaluateOpenRca needs an agent or a run to resume.");
  const id = place?.id ?? newRunId(name);
  const runs = place?.runs ?? request.runs ?? 1;
  const firstSeed =
    recorded === undefined || place === undefined
      ? (request.seed ?? randomInt(2 ** 32))
      : recorded.seed - place.run + 1;
  if (request.seed !== undefined && request.seed !== firstSeed) {
    console.error(`The runs of ${id} start at seed ${firstSeed}, not ${request.seed}.`);
    return false;
  }
  const scenarios = resumed === undefined ? request.scenarios : [...resumed.keys()];
  const runIds = Array.from({ length: runs }, (_, index) => `${id}-${index + 1}`);
  const lastSeed = firstSeed + runs - 1;
  console.log(`${runs} runs, ${runIds[0]} to ${runIds.at(-1)}, seeds ${firstSeed} to ${lastSeed}.`);
  const finish = `pnpm evorca evaluate --benchmark=openrca --resume=${runIds[0]}`;
  console.log(`If they stop, finish them with: ${finish}`);

  let sameAs = recorded;
  for (const [index, runId] of runIds.entries()) {
    const existing = await readRuns(runsDir, runId, scenarios);
    if (existing.size > 0 && [...existing.values()].every(isFinished)) {
      console.log(`\nRun ${index + 1} of ${runs}, ${runId}, is done.`);
    } else {
      console.log("");
      const member = { runId, series: { id, run: index + 1, runs }, sameAs };
      const resume = existing.size > 0 ? runId : undefined;
      const run = { ...request, scenarios, seed: firstSeed + index, resume };
      if (!(await evaluateRun(run, member)) || request.signal.aborted) return false;
    }
    sameAs ??= (await readRuns(runsDir, runId, scenarios)).values().next().value;
  }
  if (!(await reportRuns({ runsDir, scenarios, runIds }))) return false;
  const flags = scenarios.map((scenario) => `--scenario=${scenario}`).join(" ");
  const report = `pnpm evorca report --benchmark=openrca ${flags} ${runIds.join(" ")}`;
  console.log(`\nPrint this summary again with: ${report}`);
  return true;
}

type Member = {
  readonly runId: string;
  readonly series: Series;
  readonly sameAs: RunRecord | undefined;
};

async function evaluateRun(
  request: EvaluateRequest & Dirs,
  member: Member | undefined,
): Promise<boolean> {
  const { dataDir, cacheDir, runsDir, agentsDir } = request;
  const runRecords =
    request.resume === undefined
      ? undefined
      : await readRuns(runsDir, request.resume, allScenarios);
  if (runRecords?.size === 0) {
    console.error(`No run ${request.resume} in ${relative(process.cwd(), runsDir)}.`);
    return false;
  }
  const resumed =
    runRecords &&
    new Map([...runRecords].filter(([scenario]) => request.scenarios.includes(scenario)));
  if (runRecords !== undefined && resumed?.size === 0) {
    const covered = [...runRecords.keys()].join(", ");
    console.error(`Run ${request.resume} covers ${covered}, not ${request.scenarios.join(", ")}.`);
    return false;
  }
  const recorded = resumed?.values().next().value;
  const sameAs = recorded ?? member?.sameAs;
  const name = sameAs?.agent.name ?? request.agent;
  if (name === undefined) throw new Error("evaluateOpenRca needs an agent or a run to resume.");
  const runId = recorded?.runId ?? member?.runId ?? newRunId(name);
  const series = recorded?.series ?? member?.series;
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
  const rows = request.rows ?? sameAs?.rows ?? null;
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
  const modelId = request.model ?? sameAs?.model?.id ?? defaultModel;
  const model: ModelSettings | null = agent.needsModel
    ? {
        id: modelId,
        effort: request.effort ?? sameAs?.model?.effort ?? models[modelId].defaultEffort,
        taskBudgetUsd:
          request.taskBudgetUsd ?? sameAs?.model?.taskBudgetUsd ?? defaultTaskBudgetUsd,
        upstreamUrl: request.upstreamUrl,
        prices: {
          table: priceTable.id,
          source: priceTable.source,
          checkedAt: priceTable.checkedAt,
          usdPerMTok: models[modelId].usdPerMTok,
        },
      }
    : null;
  if (sameAs !== undefined) {
    const seed = recorded === undefined ? undefined : request.seed;
    const problems = conflicts(sameAs, { agent: agentRecord, seed, rows, model });
    if (problems.length > 0) {
      console.error(
        recorded === undefined
          ? `Run ${runId} cannot start, because its settings differ from run ${sameAs.runId}:`
          : `Run ${runId} cannot resume with other settings:`,
      );
      for (const problem of problems) console.error(`  ${problem}`);
      return false;
    }
  }
  const budgetUsd = agent.needsModel
    ? (request.budgetUsd ?? sameAs?.budgetUsd ?? defaultBudgetUsd)
    : null;
  const seed = recorded?.seed ?? request.seed ?? randomInt(2 ** 32);
  const jobs = request.jobs ?? sameAs?.jobs ?? defaultJobs;
  const git = await gitState(agentsDir);
  const versions = { node: process.version, docker };
  console.log(`Agent ${name}, image ${image.tag}, ${image.id}`);
  console.log(
    series === undefined
      ? `Seed ${seed}. Set EVORCA_SEED=${seed} to repeat this run.`
      : `Seed ${seed}.`,
  );
  console.log(`git ${git.commit}${git.dirty ? " with uncommitted changes" : ""}`);
  console.log(`node ${process.version}, docker ${docker.client}, daemon ${docker.server}`);
  if (model !== null) {
    const budgets = `$${budgetUsd} for the run, $${model.taskBudgetUsd} per task`;
    console.log(`Model ${model.id}, effort ${model.effort}, ${budgets}, via ${model.upstreamUrl}`);
  }
  const pace = `${jobs} ${jobs === 1 ? "task" : "tasks"} at a time`;
  const which = series === undefined ? "" : ` ${series.run} of ${series.runs},`;
  console.log(`${recorded === undefined ? "Run" : "Resuming run"}${which} ${runId}, ${pace}.`);
  const memoryMiB = await dockerMemoryMiB();
  if (jobs * agent.resources.memoryMiB > memoryMiB) {
    const asked = `${jobs} tasks at ${agent.resources.memoryMiB} MiB`;
    console.log(`Warning: ${asked} need more than Docker's ${memoryMiB} MiB of memory.`);
  }

  if (request.signal.aborted) return false;
  if (recorded !== undefined) await removeRun(runId);
  const startedAt = new Date().toISOString();
  const plans: ScenarioPlan[] = [];
  for (const [scenario, scenarioTasks] of tasks) {
    const runDir = join(runsDir, scenario, runId);
    const previous = resumed?.get(scenario);
    const selected =
      rows === null ? scenarioTasks : scenarioTasks.filter((task) => rows.includes(task.row));
    const pending = tasksToRun(selected, previous?.tasks ?? []);
    const pendingRows = new Set(pending.map((task) => task.row));
    const abandoned: { row: number; usage: ModelUsage }[] = [];
    for (const task of pending) {
      const log = await readFile(join(taskDirOf(runDir, task.row), "requests.jsonl"), "utf8").catch(
        () => "",
      );
      if (model !== null && log !== "") {
        abandoned.push({ row: task.row, usage: usageOfLog(log, model.prices.usdPerMTok) });
      }
    }
    const kept = (previous?.tasks ?? []).filter((task) => !pendingRows.has(task.row));
    const record: RunRecord =
      previous === undefined
        ? {
            runId,
            benchmark: "openrca",
            scenario,
            series,
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
            tasks: kept,
            abandoned: [...previous.abandoned, ...abandoned],
            usage:
              model === null
                ? null
                : totalUsage(kept, [...previous.abandoned, ...abandoned], model),
          };
    await mkdir(runDir, { recursive: true });
    await writeJson(join(runDir, "run.json"), record);
    for (const task of pending) {
      await rm(taskDirOf(runDir, task.row), { recursive: true, force: true });
    }
    plans.push({ scenario, tasks: scenarioTasks, selected, runDir, record });
  }

  const { signal } = request;
  let sweeper: NodeJS.Timeout | undefined;
  let modelSession: ModelSession | undefined;
  const onStop = () => {
    // A task that was starting when the signal came may start its container after one sweep.
    const sweep = () => void removeRunContainers(runId).catch(() => {});
    sweep();
    sweeper = setInterval(sweep, 1000);
  };
  if (signal.aborted) onStop();
  else signal.addEventListener("abort", onStop, { once: true });
  try {
    if (model !== null && budgetUsd !== null && request.apiKey !== undefined) {
      const others = [...(runRecords?.values() ?? [])].filter(
        (other) => !plans.some((plan) => plan.scenario === other.scenario),
      );
      const usages = [...plans.map((plan) => plan.record), ...others].map(
        (record) => record.usage ?? noUsage,
      );
      const spent = usages.reduce(
        (sum, usage) => addUsage(sum, usage, model.prices.usdPerMTok),
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
        if (!signal.aborted) console.error(error instanceof Error ? error.message : String(error));
        return undefined;
      });
      modelSession = relay === undefined ? undefined : { settings: model, budgetUsd, proxy, relay };
      if (relay === undefined) {
        await proxy.close();
        return false;
      }
    }
    const session: Session = { jobs, dataDir, cacheDir, signal, model: modelSession };
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
    signal.removeEventListener("abort", onStop);
    clearInterval(sweeper);
    if (modelSession !== undefined) await modelSession.proxy.close();
    await removeRun(runId).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Could not remove the containers and networks of run ${runId}: ${reason}`);
    });
    if (signal.aborted) {
      const resume = `pnpm evorca evaluate --benchmark=openrca --resume=${runId}`;
      const what = series === undefined ? "Resume" : `Finish the ${series.runs} runs`;
      console.error(`Stopped. ${what} with: ${resume}`);
    }
  }
}

/**
 * Runs the tasks of one scenario that `tasksToRun` picks, rewrites `run.json`
 * after each, then scores the run and sets `endedAt`. It returns the scores of
 * the run's rows, or undefined if the session's signal aborts.
 */
async function evaluateScenario(
  { scenario, tasks, selected, runDir, record }: ScenarioPlan,
  session: Session,
): Promise<ScoredRow[] | undefined> {
  const { jobs, dataDir, cacheDir, signal, model } = session;
  const pending = tasksToRun(selected, record.tasks);
  const records = new Map(record.tasks.map((task) => [task.row, task]));
  const done = records.size > 0 ? `, ${records.size} done` : "";
  const folder = relative(process.cwd(), runDir);
  const count = `${selected.length} ${selected.length === 1 ? "task" : "tasks"}`;
  const { series } = record;
  const label = series === undefined ? scenario : `run ${series.run}/${series.runs} ${scenario}`;
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
      if (taskRecord === undefined) return;
      records.set(task.row, taskRecord);
      if (!signal.aborted) {
        const { taskIndex, outcome, seconds, usage } = taskRecord;
        const progress = `${records.size}/${selected.length} ${taskIndex}`;
        const cost =
          model === undefined || usage === null
            ? ""
            : `, $${usage.costUsd.toFixed(4)}, run $${model.proxy.usage().costUsd.toFixed(4)}`;
        console.log(`${label} ${progress} ${outcome} ${seconds.toFixed(2)} s${cost}`);
      }
      await save(null);
    },
    signal,
  );
  if (signal.aborted) return undefined;

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
  await save(new Date().toISOString());

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
 * calls a model, the task gets a token and a network for the time it runs. Its
 * outcome is `budget-exhausted` if the run's budget is spent before it starts,
 * or if the run's budget denies one of its requests, because which running
 * tasks the run's budget cuts short depends on timing. Its outcome is
 * `stopped`, with what it spent, if the session's signal aborts while it runs.
 *
 * @throws Error if the session's signal aborts before the container starts, or
 *   if the relay stopped while the task ran.
 */
async function runTask(
  task: OpenRcaTask,
  { runId, scenario, agent, seed }: RunRecord,
  runDir: string,
  { dataDir, model, signal }: Session,
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
  let exit: Exit | undefined;
  let usage: ModelUsage | null = null;
  let cutByRun = false;
  if (model === undefined) {
    signal.throwIfAborted();
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
      signal.throwIfAborted();
      exit = await runContainer({ ...container, model: access }, logPath);
      await relay.assertRunning();
    } catch (error: unknown) {
      if (!signal.aborted) throw error;
    } finally {
      usage = await proxy.closeTask(token);
      // The task's outcome is already known. A network that fails to close stays
      // until the run removes its networks.
      await relay.closeNetwork(name).catch(() => {});
    }
    cutByRun = usage.budgetExhausted && usage.costUsd < settings.taskBudgetUsd;
  }
  const seconds = Math.round(performance.now() - started) / 1000;
  if (signal.aborted || exit === undefined) {
    return { row, taskIndex, outcome: "stopped", exitCode: null, seconds, usage };
  }
  const prediction = await readFile(join(taskDir, "out", "prediction.json"), "utf8").catch(
    () => undefined,
  );
  const outcome = cutByRun ? "budget-exhausted" : outcomeOf(exit, prediction).outcome;
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

const allScenarios = Object.keys(openRcaScenarios).filter((scenario): scenario is OpenRcaScenario =>
  Object.hasOwn(openRcaScenarios, scenario),
);

function newRunId(agent: AgentName): string {
  return `${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${agent}`;
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
