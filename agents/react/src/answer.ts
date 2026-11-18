/**
 * The `submit_answer` tool, and the answer that the model gives through it.
 *
 * The tool takes one root cause per failure, each with a datetime, a component,
 * and a reason, any of them null. Its schema is strict, so the API returns only
 * inputs that match it, and with candidates the component and the reason are
 * enums of them. {@link readAnswer} still checks every input, because the model
 * can give a datetime in the wrong format or leave out a field that the task
 * scores. A rejected answer keeps its valid fields as a partial answer.
 *
 * OpenRCA's evaluator finds each root cause in the prediction with a regular
 * expression that expects the fields in the order datetime, component, reason,
 * so {@link formatPrediction} writes them in that order.
 *
 * @module
 */
import type Anthropic from "@anthropic-ai/sdk";
import { isRecord, type Candidates, type Task, type TaskIndex } from "./task.ts";

/** A field of a root cause. */
export type Field = "datetime" | "component" | "reason";

/** One root cause of an answer. A field is absent when the answer leaves it out. */
export type Cause = { readonly [field in Field]?: string };

/** An answer read from `submit_answer`, or why it was rejected and what of it is valid. */
export type Reading =
  | { readonly valid: true; readonly causes: readonly Cause[] }
  | {
      readonly valid: false;
      readonly problems: readonly string[];
      readonly partial: readonly Cause[];
    };

const fields = ["datetime", "component", "reason"] as const satisfies readonly Field[];

const inputNames: Readonly<Record<Field, string>> = {
  datetime: "occurrence_datetime",
  component: "component",
  reason: "reason",
};

const predictionNames: Readonly<Record<Field, string>> = {
  datetime: "root cause occurrence datetime",
  component: "root cause component",
  reason: "root cause reason",
};

const scoredFields: Readonly<Record<TaskIndex, readonly Field[]>> = {
  task_1: ["datetime"],
  task_2: ["reason"],
  task_3: ["component"],
  task_4: ["datetime", "reason"],
  task_5: ["datetime", "component"],
  task_6: ["component", "reason"],
  task_7: ["datetime", "component", "reason"],
};

/** The name of the answer tool. */
export const submitAnswer = "submit_answer";

/**
 * Returns the definition of the `submit_answer` tool. With candidates, the
 * component and the reason must be one of them.
 */
export function submitAnswerTool(candidates: Candidates | undefined): Anthropic.Tool {
  const choice = (names: readonly string[] | undefined) =>
    names === undefined ? { type: "string" } : { type: "string", enum: names };
  const nullable = (schema: object, description: string) => ({
    anyOf: [schema, { type: "null" }],
    description,
  });
  return {
    name: submitAnswer,
    description:
      "Submit your final answer to the issue: the root cause of each failure. Call it once, when you have found the root causes. It ends your investigation.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        root_causes: {
          type: "array",
          description: "One root cause per failure, as many as the issue says occurred.",
          items: {
            type: "object",
            properties: {
              [inputNames.datetime]: nullable(
                { type: "string" },
                "When the root cause occurred, in UTC+8, in the format YYYY-MM-DD HH:MM:SS. null if the issue does not ask for it.",
              ),
              [inputNames.component]: nullable(
                choice(candidates?.components),
                "The root cause component. null if the issue does not ask for it.",
              ),
              [inputNames.reason]: nullable(
                choice(candidates?.reasons),
                "The root cause reason. null if the issue does not ask for it.",
              ),
            },
            required: fields.map((field) => inputNames[field]),
            additionalProperties: false,
          },
        },
      },
      required: ["root_causes"],
      additionalProperties: false,
    },
  };
}

/**
 * Reads the input of a `submit_answer` call for `task`. The answer is valid if
 * it has at least one root cause, every field it gives is valid, and every root
 * cause gives each field that the task scores. A datetime is valid in the form
 * `YYYY-MM-DD HH:MM:SS` for a time that exists. With candidates, a component or
 * a reason is valid if it is one of them, and otherwise if it is not empty.
 */
export function readAnswer(input: unknown, task: Task): Reading {
  const rootCauses = isRecord(input) ? input.root_causes : undefined;
  if (!Array.isArray(rootCauses) || rootCauses.length === 0) {
    return {
      valid: false,
      problems: ["root_causes must list at least one root cause."],
      partial: [],
    };
  }
  const problems: string[] = [];
  const causes = rootCauses.map((value: unknown, i): Cause => {
    const label = `Root cause ${i + 1}`;
    if (!isRecord(value)) {
      problems.push(`${label} is not an object.`);
      return {};
    }
    const cause: { [field in Field]?: string } = {};
    for (const field of fields) {
      const given = value[inputNames[field]];
      if (given === null || given === undefined) continue;
      const problem = checkField(field, given, task.candidates);
      if (problem === undefined && typeof given === "string") cause[field] = given;
      else problems.push(`${label}: ${problem}`);
    }
    for (const field of scoredFields[task.taskIndex]) {
      if (cause[field] === undefined && value[inputNames[field]] == null) {
        problems.push(`${label} has no ${inputNames[field]}, which the issue asks for.`);
      }
    }
    return cause;
  });
  if (problems.length === 0) return { valid: true, causes };
  return {
    valid: false,
    problems,
    partial: causes.some((cause) => Object.keys(cause).length > 0) ? causes : [],
  };
}

function checkField(
  field: Field,
  given: unknown,
  candidates: Candidates | undefined,
): string | undefined {
  const name = inputNames[field];
  if (typeof given !== "string") return `${name} must be a string or null.`;
  if (field === "datetime") {
    return isDatetime(given)
      ? undefined
      : `${name} ${JSON.stringify(given)} is not a datetime in the format YYYY-MM-DD HH:MM:SS.`;
  }
  const allowed = field === "component" ? candidates?.components : candidates?.reasons;
  if (allowed !== undefined && !allowed.includes(given)) {
    return `${name} ${JSON.stringify(given)} is not one of the possible root cause ${field}s.`;
  }
  return given.trim() === "" ? `${name} is empty.` : undefined;
}

function isDatetime(text: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
    .exec(text)
    ?.slice(1)
    .map(Number);
  if (parts === undefined) return false;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts;
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(time).toISOString().slice(0, 19).replace("T", " ") === text;
}

/**
 * Formats root causes as OpenRCA prediction JSON, numbered from 1, with each
 * cause's fields in the order that the evaluator expects, such as
 * `{"1":{"root cause occurrence datetime":"2020-04-11 00:05:00"}}`.
 */
export function formatPrediction(causes: readonly Cause[]): string {
  return JSON.stringify(
    Object.fromEntries(
      causes.map((cause, i) => [
        String(i + 1),
        Object.fromEntries(
          fields.flatMap((field) => {
            const value = cause[field];
            return value === undefined ? [] : [[predictionNames[field], value]];
          }),
        ),
      ]),
    ),
  );
}
