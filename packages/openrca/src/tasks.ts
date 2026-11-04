/**
 * Reads OpenRCA tasks from each system's `query.csv`.
 *
 * A `query.csv` row holds a task index, the instruction for the agent, and the
 * scoring points that grade the answer. A task leaves out the scoring points,
 * so an agent that reads tasks never sees the answers.
 *
 * @module
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCsv } from "./csv.js";

/** The four OpenRCA systems. Each name is also the system's directory in the dataset. */
export const openRcaSystems = [
  "Bank",
  "Telecom",
  "Market/cloudbed-1",
  "Market/cloudbed-2",
] as const;

/** The name of one OpenRCA system, such as `Market/cloudbed-1`. */
export type OpenRcaSystem = (typeof openRcaSystems)[number];

const taskIndices = ["task_1", "task_2", "task_3", "task_4", "task_5", "task_6", "task_7"] as const;

/**
 * The kind of an OpenRCA task, which decides the root cause fields an answer
 * needs. `task_1` asks for the datetime, `task_2` for the reason, and `task_3`
 * for the component. `task_4` to `task_6` ask for two of them, and `task_7`
 * asks for all three.
 */
export type TaskIndex = (typeof taskIndices)[number];

/**
 * One OpenRCA task, without its scoring points. `row` is the zero-based row of
 * the task in `query.csv`, and a prediction file answers the task on the same
 * row. `instruction` tells the agent the time range and the number of failures.
 */
export type OpenRcaTask = {
  readonly system: OpenRcaSystem;
  readonly row: number;
  readonly taskIndex: TaskIndex;
  readonly instruction: string;
};

/**
 * Parses the text of a `task_index` field.
 *
 * @throws Error if `value` is not one of `task_1` to `task_7`.
 */
export function parseTaskIndex(value: string): TaskIndex {
  const taskIndex = taskIndices.find((candidate) => candidate === value);
  if (taskIndex === undefined) throw new Error(`Unknown OpenRCA task index: ${value}`);
  return taskIndex;
}

/**
 * Reads the tasks in `<dataDir>/<system>/query.csv`, one per row, in file order.
 *
 * @throws Error if `query.csv` cannot be read, lacks the `task_index`,
 *   `instruction`, or `scoring_points` column, or holds an unknown task index.
 */
export async function readTasks(system: OpenRcaSystem, dataDir: string): Promise<OpenRcaTask[]> {
  const text = await readFile(join(dataDir, system, "query.csv"), "utf8");
  return parseCsv(text, ["task_index", "instruction", "scoring_points"]).map((record, row) => ({
    system,
    row,
    taskIndex: parseTaskIndex(record.task_index),
    instruction: record.instruction,
  }));
}
