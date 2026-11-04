/**
 * Converts a `Diagnosis` to and from OpenRCA's prediction JSON, and writes the
 * prediction CSV that the official evaluator scores.
 *
 * A prediction is a JSON object that numbers the root causes from 1, such as
 * `{"1": {"root cause occurrence datetime": "2020-04-11 00:05:00", "root cause component": "docker_003"}}`.
 * The evaluator finds each cause with a regular expression that expects the
 * fields in the order datetime, component, reason. It does not see a cause
 * whose fields come in another order, so {@link formatPrediction} always writes
 * them in that order.
 *
 * @module
 */
import type { Diagnosis, RootCause } from "@evorca/core";
import { stringify } from "csv-stringify/sync";
import { parseOpenRcaDatetime, toOpenRcaDatetime } from "./datetime.js";

const fields = {
  occurredAt: "root cause occurrence datetime",
  component: "root cause component",
  reason: "root cause reason",
} as const;

/**
 * Formats a diagnosis as an OpenRCA prediction.
 *
 * @param diagnosis - The root causes to report.
 * @returns Compact JSON that numbers the causes from 1 in array order and
 *   leaves out absent fields. An empty diagnosis gives `{}`.
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
 * Parses an OpenRCA prediction, such as one that an agent wrote.
 *
 * A cause whose datetime is not a valid OpenRCA datetime gets no `occurredAt`
 * but keeps its component and reason, because the evaluator scores each field
 * on its own.
 *
 * @param raw - The prediction text.
 * @returns The causes in the order of the object's keys. Returns an empty
 *   diagnosis if `raw` is not a JSON object, or if any cause is not an object
 *   whose only keys are the three OpenRCA fields with string values.
 */
export function parsePrediction(raw: string): Diagnosis {
  let prediction: unknown;
  try {
    prediction = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(prediction)) return [];
  const causes = Object.values(prediction).map(readCause);
  return causes.every((cause) => cause !== undefined) ? causes : [];
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
 * Writes the prediction CSV for the tasks of one system.
 *
 * @param taskCount - The number of rows in the system's `query.csv`. The
 *   evaluator rejects a prediction file with a different number of rows.
 * @param diagnoses - The diagnosis for each task, keyed by the task's `row`.
 *   Keys outside 0 to `taskCount - 1` have no effect.
 * @returns CSV text with a `prediction` header and one row per task, in row
 *   order. A task with no diagnosis gets the prediction `{}`.
 */
export function writePredictions(
  taskCount: number,
  diagnoses: ReadonlyMap<number, Diagnosis>,
): string {
  const rows = Array.from({ length: taskCount }, (_, row) => ({
    prediction: formatPrediction(diagnoses.get(row) ?? []),
  }));
  return stringify(rows, { header: true, columns: ["prediction"] });
}
