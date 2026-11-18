/**
 * The `react` agent, the baseline of an evorca evaluation: Claude in a ReAct
 * loop with a bash tool over the telemetry and a tool to submit the answer,
 * with no memory between tasks and no self-improvement.
 *
 * The image runs this file. It reads the task from `/task.json` and its
 * settings from the environment, investigates the telemetry in `/data`, and
 * writes three files to `/out`: `prediction.json`, the answer as OpenRCA
 * prediction JSON, if it has one; `trajectory.jsonl`, one line per event as
 * it happens; and `summary.json`, how the task ended and what it cost. The
 * process exits with 0 whenever the loop ends, with or without an answer, and
 * with 1 only if the agent itself fails.
 *
 * The environment:
 * - `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`, which the SDK reads.
 * - `EVORCA_MODEL`, `claude-sonnet-5` by default, and `EVORCA_EFFORT`, `high`
 *   by default.
 * - `EVORCA_TASK_BUDGET_USD`, if set: the loop wraps up at 80% of it.
 * - `EVORCA_TASK_TIMEOUT_SECONDS`, if set: the loop wraps up at 80% of it.
 * - `EVORCA_SEED`, which the summary records. The model takes no seed.
 *
 * @module
 */
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import background from "../background.json" with { type: "json" };
import { formatPrediction } from "./answer.ts";
import { BashSession } from "./bash.ts";
import { efforts, investigate, type Effort, type Event, type Outcome } from "./loop.ts";
import { buildPrompt, type Background, type Limits, type Prompt } from "./prompt.ts";
import { parseTask, type Task } from "./task.ts";
import { prices, type Prices } from "./usage.ts";

/** The agent's settings from the environment. */
export type Config = {
  readonly model: string;
  readonly prices: Prices;
  readonly effort: Effort;
  readonly budgetUsd?: number;
  readonly timeoutSeconds?: number;
  readonly seed?: string;
};

/** What `summary.json` holds. */
export type Summary = Omit<Outcome, "causes" | "costUsd"> & {
  readonly model: string;
  readonly effort: Effort;
  readonly promptSha256: string;
  readonly seed: string | null;
  readonly estimatedCostUsd: number;
  readonly budgetUsd: number | null;
  readonly softBudgetUsd: number | null;
  readonly maxSteps: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly seconds: number;
};

/**
 * The agent's limits. RCA-Agent runs at most 25 controller steps, each of
 * which may execute code twice, and stops a cell after 60 seconds on two CPUs.
 */
export const limits: Limits = { maxSteps: 50, commandTimeoutSeconds: 120, outputChars: 16_000 };

const maxTokens = [16_000, 32_000] as const;
const wrapUpShare = 0.8;

/**
 * Reads the agent's settings from `env`.
 *
 * @throws Error if the model has no prices, the effort is unknown, or the
 *   budget or the timeout is not a positive number.
 */
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const model = env.EVORCA_MODEL ?? "claude-sonnet-5";
  const modelPrices = prices[model];
  if (modelPrices === undefined) throw new Error(`No prices for EVORCA_MODEL ${model}`);
  const effortName = env.EVORCA_EFFORT ?? "high";
  const effort = efforts.find((level) => level === effortName);
  if (effort === undefined) throw new Error(`Unknown EVORCA_EFFORT ${effortName}`);
  const budgetUsd = positive(env, "EVORCA_TASK_BUDGET_USD");
  const timeoutSeconds = positive(env, "EVORCA_TASK_TIMEOUT_SECONDS");
  return {
    model,
    prices: modelPrices,
    effort,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(env.EVORCA_SEED === undefined ? {} : { seed: env.EVORCA_SEED }),
  };
}

function positive(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const text = env[name];
  if (text === undefined || text === "") return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} is not a positive number: ${text}`);
  return value;
}

/** What {@link runTask} needs. The shell runs in `shellCwd` with `shellEnv`. */
export type TaskRun = {
  readonly task: Task;
  readonly config: Config;
  readonly client: Anthropic;
  readonly outDir: string;
  readonly shellCwd: string;
  readonly shellEnv: NodeJS.ProcessEnv;
  readonly limits?: Limits;
  readonly now?: () => number;
};

/**
 * Runs the agent on one task, writes its files to `outDir`, and returns the
 * summary.
 *
 * @throws Error if the agent fails, as distinct from the model or the API.
 */
export async function runTask(run: TaskRun): Promise<Summary> {
  const { task, config, client, outDir } = run;
  const now = run.now ?? Date.now;
  const taskLimits = run.limits ?? limits;
  const startedAt = now();
  const prompt = buildPrompt(task, typedBackground, taskLimits);
  const softBudgetUsd = config.budgetUsd === undefined ? undefined : config.budgetUsd * wrapUpShare;
  const deadline =
    config.timeoutSeconds === undefined
      ? undefined
      : startedAt + config.timeoutSeconds * 1000 * wrapUpShare;
  const trajectory = join(outDir, "trajectory.jsonl");
  const log = (event: Event | TaskEvent) =>
    appendFileSync(
      trajectory,
      `${JSON.stringify({ at: new Date(now()).toISOString(), ...event })}\n`,
    );
  log({
    type: "task",
    task,
    model: config.model,
    effort: config.effort,
    limits: taskLimits,
    promptSha256: prompt.sha256,
    system: prompt.system,
    tools: prompt.tools,
  });
  const shell = new BashSession({
    cwd: run.shellCwd,
    env: run.shellEnv,
    timeoutMs: taskLimits.commandTimeoutSeconds * 1000,
    outputChars: taskLimits.outputChars,
  });
  let outcome: Outcome;
  try {
    outcome = await investigate({
      client,
      prompt,
      task,
      shell,
      limits: taskLimits,
      log,
      now,
      settings: {
        model: config.model,
        effort: config.effort,
        prices: config.prices,
        maxTokens,
        ...(softBudgetUsd === undefined ? {} : { softBudgetUsd }),
        ...(deadline === undefined ? {} : { deadline }),
      },
    });
  } finally {
    shell.restart();
  }
  if (outcome.causes.length > 0) {
    await writeFile(join(outDir, "prediction.json"), formatPrediction(outcome.causes));
  }
  const endedAt = now();
  const { causes: _, costUsd, ...rest } = outcome;
  const summary: Summary = {
    ...rest,
    model: config.model,
    effort: config.effort,
    promptSha256: prompt.sha256,
    seed: config.seed ?? null,
    estimatedCostUsd: costUsd,
    budgetUsd: config.budgetUsd ?? null,
    softBudgetUsd: softBudgetUsd ?? null,
    maxSteps: taskLimits.maxSteps,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    seconds: (endedAt - startedAt) / 1000,
  };
  await writeFile(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const typedBackground: Background = background;

type TaskEvent = {
  readonly type: "task";
  readonly task: Task;
  readonly model: string;
  readonly effort: Effort;
  readonly limits: Limits;
  readonly promptSha256: string;
  readonly system: string;
  readonly tools: Prompt["tools"];
};

/**
 * The environment of the bash session: the agent's own, without the API key,
 * the proxy's address, and the agent's settings.
 */
export function shellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^(ANTHROPIC|EVORCA)_/.test(name)),
  );
}

if (import.meta.main) {
  try {
    const config = readConfig(process.env);
    const task = parseTask(await readFile("/task.json", "utf8"));
    const summary = await runTask({
      task,
      config,
      client: new Anthropic({ maxRetries: 5 }),
      outDir: "/out",
      shellCwd: "/tmp",
      shellEnv: shellEnvironment(process.env),
    });
    console.log(
      `${summary.stopCause}, ${summary.answer} answer, ${summary.steps} steps, $${summary.estimatedCostUsd.toFixed(4)}`,
    );
    process.exit(0);
  } catch (error) {
    console.error(error);
    await writeFile(
      "/out/summary.json",
      `${JSON.stringify({ stopCause: "crashed", error: String(error) }, null, 2)}\n`,
    ).catch(() => {});
    process.exit(1);
  }
}
