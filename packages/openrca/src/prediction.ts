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
 * Returns an empty diagnosis unless `raw` is a JSON object whose values are
 * objects with only the three OpenRCA fields, each a string. A cause keeps its
 * component and reason when its datetime is invalid, because the evaluator
 * scores each field on its own.
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
 * Writes the prediction CSV for one system, with a `prediction` header and one
 * row per task in row order. A task with no entry in `diagnoses` gets `{}`.
 *
 * @param taskCount - The number of rows in the system's `query.csv`, because the
 *   evaluator rejects a file with any other number of rows. Keys of `diagnoses`
 *   outside 0 to `taskCount - 1` have no effect.
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
