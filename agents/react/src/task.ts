/**
 * The task that `evorca evaluate` gives the agent in `/task.json`, parsed at
 * the boundary so the rest of the agent trusts its shape.
 *
 * @module
 */

const taskIndices = ["task_1", "task_2", "task_3", "task_4", "task_5", "task_6", "task_7"] as const;

/** The kind of an OpenRCA task, which decides the root cause fields that it scores. */
export type TaskIndex = (typeof taskIndices)[number];

/** The root cause components and reasons that an answer can name. */
export type Candidates = {
  readonly components: readonly string[];
  readonly reasons: readonly string[];
};

/** One OpenRCA task, as `/task.json` holds it. `candidates` is absent unless the agent sees them. */
export type Task = {
  readonly scenario: string;
  readonly row: number;
  readonly taskIndex: TaskIndex;
  readonly instruction: string;
  readonly candidates?: Candidates;
};

/**
 * Parses the text of `/task.json`.
 *
 * @throws Error if the text is not JSON or lacks a field of {@link Task}.
 */
export function parseTask(text: string): Task {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("task.json is not an object");
  const { scenario, row, taskIndex, instruction, candidates } = value;
  if (typeof scenario !== "string") throw new Error("task.json has no scenario");
  if (typeof row !== "number" || !Number.isInteger(row)) throw new Error("task.json has no row");
  const index = taskIndices.find((candidate) => candidate === taskIndex);
  if (index === undefined) throw new Error(`task.json has an unknown taskIndex: ${taskIndex}`);
  if (typeof instruction !== "string") throw new Error("task.json has no instruction");
  return {
    scenario,
    row,
    taskIndex: index,
    instruction,
    ...(candidates === undefined ? {} : { candidates: parseCandidates(candidates) }),
  };
}

function parseCandidates(value: unknown): Candidates {
  if (!isRecord(value) || !isStrings(value.components) || !isStrings(value.reasons)) {
    throw new Error("task.json has candidates without lists of components and reasons");
  }
  return { components: value.components, reasons: value.reasons };
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Whether `value` is a JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
