/**
 * What `/benchmark` in the shell picks. A picker is a state machine over four
 * steps: the scenarios, the tasks in each, the agent and its settings, and a
 * confirmation. `update` takes it to its next state on each key, `itemsOf`
 * lists the lines of a step, and `planOf` turns the pick into the request for
 * `evorca evaluate` and the command that repeats it.
 *
 * A task shows only its row, task index, difficulty, and instruction. The
 * picker never reads the scoring points or `record.csv`.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  difficultyOf,
  readTasks,
  type Difficulty,
  type OpenRcaScenario,
  type OpenRcaTask,
} from "@evorca/openrca";
import { agents, type AgentName } from "./agents.js";
import { efforts, models, type Effort, type ModelId } from "./models.js";
import { runDefaults, type EvaluateRequest } from "./openrca.js";
import { allScenarios, isFinished, isRunId, readRuns, type RunRecord, type Rows } from "./runs.js";

/**
 * A scenario of the benchmark: its tasks, none without `query.csv`, and
 * whether its telemetry is on disk.
 */
export type ScenarioData = {
  readonly scenario: OpenRcaScenario;
  readonly tasks: readonly OpenRcaTask[];
  readonly telemetry: boolean;
};

/** What the picker offers: the scenarios, and the runs on disk that the cost estimate learns from. */
export type Catalog = {
  readonly scenarios: readonly ScenarioData[];
  readonly runs: readonly RunRecord[];
};

/**
 * The agent, how many runs to make, and the model settings, which apply only
 * to an agent that calls a model.
 */
export type Settings = {
  readonly agent: AgentName;
  readonly runs: number;
  readonly model: ModelId;
  readonly effort: Effort;
  readonly budgetUsd: number;
  readonly taskBudgetUsd: number;
};

const steps = ["scenarios", "tasks", "agent", "confirm"] as const;

/** A step of the picker. */
export type Step = (typeof steps)[number];

/**
 * The state of the picker. `cursor` indexes the items of the step.
 * `scenarios` holds the chosen scenarios, and `rows` the chosen rows of each
 * scenario with tasks, at first all of them. `seed` is the seed of the run.
 */
export type Picker = {
  readonly step: Step;
  readonly cursor: number;
  readonly scenarios: ReadonlySet<OpenRcaScenario>;
  readonly rows: ReadonlyMap<OpenRcaScenario, ReadonlySet<number>>;
  readonly settings: Settings;
  readonly seed: number;
};

/**
 * A key of the picker. A difficulty chooses the tasks of that difficulty in
 * the scenario under the cursor, or drops them if all are chosen.
 */
export type Action = "up" | "down" | "toggle" | "left" | "right" | "next" | "back" | Difficulty;

/**
 * One line of a step. A `problem` says why the line cannot be chosen, and
 * how to fix that.
 */
export type Item =
  | {
      readonly kind: "scenario";
      readonly data: ScenarioData;
      readonly chosen: boolean;
      readonly problem: string | undefined;
    }
  | {
      readonly kind: "group";
      readonly scenario: OpenRcaScenario;
      readonly chosen: number;
      readonly tasks: number;
    }
  | {
      readonly kind: "task";
      readonly task: OpenRcaTask;
      readonly difficulty: Difficulty;
      readonly chosen: boolean;
    }
  | { readonly kind: "setting"; readonly label: string; readonly value: string };

/**
 * What a pick runs, as a request for `evorca evaluate`. `rows` holds only the
 * scenarios that the run does not cover whole.
 */
export type Plan = Pick<
  EvaluateRequest,
  "scenarios" | "model" | "effort" | "budgetUsd" | "taskBudgetUsd"
> & {
  readonly agent: AgentName;
  readonly runs: number;
  readonly seed: number;
  readonly rows: Rows;
};

type Setting<T> = {
  readonly label: string;
  readonly show: (value: T) => string;
  readonly change: (value: T, by: 1 | -1) => T;
};

const settings: { readonly [K in keyof Settings]: Setting<Settings[K]> } = {
  agent: { label: "agent", show: String, change: (agent, by) => cycle(agentNames, agent, by) },
  runs: { label: "runs", show: String, change: (runs, by) => Math.max(1, runs + by) },
  model: { label: "model", show: String, change: (model, by) => cycle(modelIds, model, by) },
  effort: { label: "effort", show: String, change: (effort, by) => cycle(efforts, effort, by) },
  budgetUsd: {
    label: "run budget",
    show: (usd) => `$${usd}`,
    change: (usd, by) => Math.max(5, usd + 5 * by),
  },
  taskBudgetUsd: {
    label: "task budget",
    show: (usd) => `$${usd}`,
    change: (usd, by) => Math.max(0.5, usd + 0.5 * by),
  },
};
const commandColumns = 72;
const agentNames = Object.keys(agents).filter((name): name is AgentName => name in agents);
const modelIds = Object.keys(models).filter((id): id is ModelId => id in models);

/**
 * Reads what the picker offers: the tasks and the telemetry of each scenario
 * in `dataDir`, and the `run.json` of each run in `runsDir`.
 *
 * @throws Error if a `query.csv` or a `run.json` exists but cannot be read.
 */
export async function readCatalog(dataDir: string, runsDir: string): Promise<Catalog> {
  const scenarios = await Array.fromAsync(allScenarios, async (scenario) => ({
    scenario,
    tasks: existsSync(join(dataDir, scenario, "query.csv"))
      ? await readTasks(scenario, dataDir)
      : [],
    telemetry: existsSync(join(dataDir, scenario, "telemetry")),
  }));
  const runs: RunRecord[] = [];
  for (const scenario of allScenarios) {
    const ids = await readdir(join(runsDir, scenario)).catch(() => []);
    for (const id of ids.filter(isRunId)) {
      runs.push(...(await readRuns(runsDir, id, [scenario])).values());
    }
  }
  return { scenarios, runs };
}

/** The picker at its first step, with no scenario chosen, every task chosen, and the default settings. */
export function openPicker(catalog: Catalog, seed: number): Picker {
  return {
    step: "scenarios",
    cursor: 0,
    scenarios: new Set(),
    rows: new Map(
      catalog.scenarios.map(({ scenario, tasks }) => [
        scenario,
        new Set(tasks.map((task) => task.row)),
      ]),
    ),
    settings: {
      agent: "random",
      runs: 1,
      model: runDefaults.model,
      effort: models[runDefaults.model].defaultEffort,
      budgetUsd: runDefaults.budgetUsd,
      taskBudgetUsd: runDefaults.taskBudgetUsd,
    },
    seed,
  };
}

/** The lines of the picker's step, which the cursor moves over. The confirmation has none. */
export function itemsOf(picker: Picker, catalog: Catalog): Item[] {
  if (picker.step === "scenarios") {
    return catalog.scenarios.map((data) => ({
      kind: "scenario",
      data,
      chosen: picker.scenarios.has(data.scenario),
      problem: data.tasks.length > 0 ? undefined : `Fetch its tasks with ${fetch([data.scenario])}`,
    }));
  }
  if (picker.step === "tasks") {
    return chosen(picker, catalog).flatMap(({ scenario, tasks }): Item[] => {
      const rows = picker.rows.get(scenario) ?? new Set();
      return [
        { kind: "group", scenario, chosen: rows.size, tasks: tasks.length },
        ...tasks.map((task): Item => ({
          kind: "task",
          task,
          difficulty: difficultyOf[task.taskIndex],
          chosen: rows.has(task.row),
        })),
      ];
    });
  }
  if (picker.step === "agent") {
    return shownSettings(picker.settings).map((name) => ({
      kind: "setting",
      label: settings[name].label,
      value: shown(picker.settings, name),
    }));
  }
  return [];
}

/** Why the picker cannot go on from its step, or undefined if it can. */
export function blockerOf(picker: Picker, catalog: Catalog): string | undefined {
  if (picker.step === "scenarios" && picker.scenarios.size === 0) return "Choose a scenario.";
  if (picker.step === "tasks" && planOf(picker, catalog).scenarios.length === 0) {
    return "Choose a task.";
  }
  if (picker.step === "agent") return agentProblem(picker, catalog);
  return undefined;
}

/**
 * The picker's next state after `action`, or `cancel` if it closes, or
 * `start` if the user confirms the run that `planOf` gives.
 */
export function update(
  picker: Picker,
  action: Action,
  catalog: Catalog,
): Picker | "cancel" | "start" {
  const items = itemsOf(picker, catalog);
  const item = items[picker.cursor];
  const step = steps.indexOf(picker.step);
  if (action === "up" || action === "down") {
    const cursor = picker.cursor + (action === "up" ? -1 : 1);
    return { ...picker, cursor: Math.max(0, Math.min(items.length - 1, cursor)) };
  }
  if (action === "back") {
    const previous = steps[step - 1];
    return previous === undefined ? "cancel" : { ...picker, step: previous, cursor: 0 };
  }
  if (action === "next") {
    if (blockerOf(picker, catalog) !== undefined) return picker;
    const next = steps[step + 1];
    return next === undefined ? "start" : { ...picker, step: next, cursor: 0 };
  }
  if (action === "left" || action === "right") {
    if (picker.step !== "agent") return picker;
    const name = shownSettings(picker.settings)[picker.cursor];
    return name === undefined
      ? picker
      : { ...picker, settings: changed(picker.settings, name, action === "left" ? -1 : 1) };
  }
  if (item?.kind === "scenario") {
    if (action !== "toggle" || item.problem !== undefined) return picker;
    const scenarios = new Set(picker.scenarios);
    if (!scenarios.delete(item.data.scenario)) scenarios.add(item.data.scenario);
    return { ...picker, scenarios };
  }
  if (item?.kind !== "group" && item?.kind !== "task") return picker;
  const scenario = item.kind === "group" ? item.scenario : item.task.scenario;
  const tasks = catalog.scenarios.find((data) => data.scenario === scenario)?.tasks ?? [];
  if (action === "toggle")
    return flip(picker, scenario, item.kind === "task" ? [item.task] : tasks);
  return flip(
    picker,
    scenario,
    tasks.filter((task) => difficultyOf[task.taskIndex] === action),
  );
}

/** The run that the picker's choices describe. */
export function planOf(picker: Picker, catalog: Catalog): Plan {
  const covered = chosen(picker, catalog).flatMap(({ scenario, tasks }) => {
    const rows = picker.rows.get(scenario) ?? new Set();
    return rows.size === 0 ? [] : [{ scenario, rows: [...rows].sort((a, b) => a - b), tasks }];
  });
  const { agent, runs, model, effort, budgetUsd, taskBudgetUsd } = picker.settings;
  const modelSettings = agents[agent].needsModel
    ? { model, effort, budgetUsd, taskBudgetUsd }
    : { model: undefined, effort: undefined, budgetUsd: undefined, taskBudgetUsd: undefined };
  return {
    scenarios: covered.map(({ scenario }) => scenario),
    rows: new Map(
      covered.flatMap(({ scenario, rows, tasks }) =>
        rows.length === tasks.length ? [] : [[scenario, rows] as const],
      ),
    ),
    agent,
    runs,
    seed: picker.seed,
    ...modelSettings,
  };
}

/**
 * The command that runs `plan` from a terminal at the repository root. It
 * breaks between flags into lines that end in a backslash, so a copy of it
 * runs as it is. A line takes at most 72 columns, or `room` columns where the
 * screen has fewer. To fit, the rows of a scenario go in as many `--rows`
 * values as the lines need.
 */
export function commandOf(plan: Plan, room: number = commandColumns): string {
  const columns = Math.min(commandColumns, room);
  const indent = "  ";
  const more = " \\";
  const words = [
    `EVORCA_SEED=${plan.seed}`,
    "pnpm",
    "evorca",
    "evaluate",
    "--benchmark=openrca",
    `--agent=${plan.agent}`,
    ...plan.scenarios.map((scenario) => `--scenario=${scenario}`),
    ...[...plan.rows].flatMap(([scenario, rows]) =>
      rowFlags(scenario, rows, columns - indent.length - more.length),
    ),
    ...(plan.runs === 1 ? [] : [`--runs=${plan.runs}`]),
    ...(plan.model === undefined ? [] : [`--model=${plan.model}`]),
    ...(plan.effort === undefined ? [] : [`--effort=${plan.effort}`]),
    ...(plan.budgetUsd === undefined ? [] : [`--budget-usd=${plan.budgetUsd}`]),
    ...(plan.taskBudgetUsd === undefined ? [] : [`--task-budget-usd=${plan.taskBudgetUsd}`]),
  ];
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}${more}`.length <= columns) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else lines.push(last === undefined ? word : `${indent}${word}`);
  }
  return lines.join(`${more}\n`);
}

/** How many tasks `plan` runs in each of its runs. */
export function tasksOf(plan: Plan, catalog: Catalog): number {
  return plan.scenarios.reduce((sum, scenario) => {
    const whole = catalog.scenarios.find((data) => data.scenario === scenario)?.tasks.length ?? 0;
    return sum + (plan.rows.get(scenario)?.length ?? whole);
  }, 0);
}

/**
 * Estimates what `plan` spends on the model: its tasks over all its runs
 * times the mean cost per task of the finished runs in the catalog with the
 * same agent, model, and effort. It is undefined for an agent that calls no
 * model, and when no such run is finished.
 */
export function estimateOf(
  plan: Plan,
  catalog: Catalog,
): { readonly usd: number; readonly perTaskUsd: number; readonly from: number } | undefined {
  const same = catalog.runs.filter(
    (record) =>
      isFinished(record) &&
      record.agent.name === plan.agent &&
      record.model?.id === plan.model &&
      record.model?.effort === plan.effort,
  );
  const from = same.reduce((sum, record) => sum + record.tasks.length, 0);
  if (plan.model === undefined || from === 0) return undefined;
  const perTaskUsd = same.reduce((sum, record) => sum + (record.usage?.costUsd ?? 0), 0) / from;
  return { usd: perTaskUsd * tasksOf(plan, catalog) * plan.runs, perTaskUsd, from };
}

function chosen(picker: Picker, catalog: Catalog): readonly ScenarioData[] {
  return catalog.scenarios.filter(({ scenario }) => picker.scenarios.has(scenario));
}

function agentProblem(picker: Picker, catalog: Catalog): string | undefined {
  const { agent } = picker.settings;
  const missing = chosen(picker, catalog)
    .filter((data) => !data.telemetry)
    .map((data) => data.scenario);
  if (!agents[agent].needsTelemetry || missing.length === 0) return undefined;
  return `Fetch the telemetry that ${agent} reads with ${fetch(missing)}`;
}

function rowFlags(scenario: OpenRcaScenario, rows: readonly number[], width: number): string[] {
  const flags: string[] = [];
  for (const row of rows) {
    const last = flags.at(-1);
    if (last !== undefined && `${last},${row}`.length <= width) {
      flags[flags.length - 1] = `${last},${row}`;
    } else flags.push(`--rows=${scenario}:${row}`);
  }
  return flags;
}

function fetch(scenarios: readonly OpenRcaScenario[]): string {
  const flags = scenarios.map((scenario) => `--scenario=${scenario}`).join(" ");
  return `pnpm evorca fetch --benchmark=openrca ${flags}`;
}

function shownSettings(current: Settings): (keyof Settings)[] {
  const always = ["agent", "runs"] as const;
  const model = ["model", "effort", "budgetUsd", "taskBudgetUsd"] as const;
  return agents[current.agent].needsModel ? [...always, ...model] : [...always];
}

function shown<K extends keyof Settings>(current: Settings, name: K): string {
  return settings[name].show(current[name]);
}

function changed<K extends keyof Settings>(current: Settings, name: K, by: 1 | -1): Settings {
  return { ...current, [name]: settings[name].change(current[name], by) };
}

function flip(picker: Picker, scenario: OpenRcaScenario, tasks: readonly OpenRcaTask[]): Picker {
  const rows = new Set(picker.rows.get(scenario));
  const choose = !tasks.every((task) => rows.has(task.row));
  for (const { row } of tasks) {
    if (choose) rows.add(row);
    else rows.delete(row);
  }
  return { ...picker, rows: new Map(picker.rows).set(scenario, rows) };
}

function cycle<T>(values: readonly T[], value: T, by: 1 | -1): T {
  const index = values.indexOf(value);
  return values[(index + by + values.length) % values.length] ?? value;
}
