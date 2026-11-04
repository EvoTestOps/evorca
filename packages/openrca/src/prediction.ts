/**
 * Converts a `Diagnosis` to and from OpenRCA's prediction JSON, and writes the
 * prediction CSV that the official evaluator scores. A prediction numbers the
 * root causes from 1, as in `{"1": {"root cause component": "docker_003"}}`.
 * The evaluator finds each cause with a regular expression that expects the
 * fields in the order datetime, component, reason, and misses a cause whose
 * fields come in another order, so {@link formatPrediction} keeps that order.
 *
 * @module
 */
import type { Diagnosis, RootCause } from "@evorca/core";
import { stringify } from "csv-stringify/sync";
import { parseOpenRcaDatetime, toOpenRcaDatetime } from "./datetime.js";
import type { OpenRcaTask } from "./tasks.js";

const fields = {
  occurredAt: "root cause occurrence datetime",
  component: "root cause component",
  reason: "root cause reason",
} as const;

/**
 * Formats `diagnosis` as compact prediction JSON. It numbers the causes from 1
 * in array order and leaves out absent fields, so an empty diagnosis gives `{}`.
 */
export function formatPrediction(diagnosis: Diagnosis): string {
  return JSON.stringify(
    Object.fromEntries(
      diagnosis.map((cause, i) => [
        String(i + 1),
        {
          [fields.occurredAt]:
            cause.occurredAt === undefined ? undefined : toOpenRcaDatetime(cause.occurredAt),
          [fields.component]: cause.component,
          [fields.reason]: cause.reason,
        },
      ]),
    ),
  );
}

/**
 * Parses prediction JSON, such as an agent's answer, into causes in key order.
 * Returns undefined unless `raw` is a JSON object whose values are objects with
 * only the three OpenRCA fields, each a string, so only `{}` gives no causes. A
 * cause keeps its component and reason when its datetime is invalid, because
 * the evaluator scores each field on its own.
 */
export function parsePrediction(raw: string): Diagnosis | undefined {
  const prediction = parseJson(raw);
  if (!isRecord(prediction)) return undefined;
  const causes = Object.values(prediction).map(readCause);
  return causes.every((cause) => cause !== undefined) ? causes : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readCause(value: unknown): RootCause | undefined {
  if (!isRecord(value)) return undefined;
  const {
    [fields.occurredAt]: datetime,
    [fields.component]: component,
    [fields.reason]: reason,
    ...rest
  } = value;
  if (Object.keys(rest).length > 0) return undefined;
  if (!isOptionalString(datetime) || !isOptionalString(component) || !isOptionalString(reason)) {
    return undefined;
  }
  return {
    occurredAt: datetime === undefined ? undefined : parseOpenRcaDatetime(datetime),
    component,
    reason,
  };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Writes the prediction CSV for one system, with a `prediction` header and one
 * row per task in the order of `tasks`. A task gets the diagnosis keyed by its
 * `row`, or `{}` if `diagnoses` has none.
 *
 * @param tasks - Every task of the system in row order, as `readTasks` returns
 *   them, because the evaluator matches predictions to tasks by position.
 */
export function writePredictions(
  tasks: readonly OpenRcaTask[],
  diagnoses: ReadonlyMap<number, Diagnosis>,
): string {
  const rows = tasks.map((task) => ({
    prediction: formatPrediction(diagnoses.get(task.row) ?? []),
  }));
  return stringify(rows, { header: true, columns: ["prediction"] });
}
