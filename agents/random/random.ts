/**
 * The `random` agent, the chance-level floor of an OpenRCA evaluation. It reads
 * no telemetry. For each failure that the instruction in `/task.json` counts,
 * it draws a minute uniformly from the instruction's time window, and a
 * component and a reason uniformly from the task's candidates. It writes the
 * answer to `/out/prediction.json` as OpenRCA prediction JSON.
 *
 * Each draw comes from the SHA-256 of `EVORCA_SEED`, the scenario, the row,
 * and a counter, so the same seed gives the same answers on every run.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

/** The fields of `/task.json` that the agent reads. */
export type Task = {
  readonly scenario: string;
  readonly row: number;
  readonly instruction: string;
  readonly candidates?: {
    readonly components: readonly string[];
    readonly reasons: readonly string[];
  };
};

/**
 * The time window of a task and the number of failures in it. `start` and
 * `end` are the instruction's wall-clock times, read as UTC, in milliseconds.
 */
export type Window = { readonly start: number; readonly end: number; readonly failures: number };

/** One root cause in OpenRCA prediction JSON. */
export type Cause = {
  readonly "root cause occurrence datetime": string;
  readonly "root cause component"?: string;
  readonly "root cause reason"?: string;
};

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const counts: Readonly<Record<string, number>> = { a: 1, one: 1, single: 1, two: 2, three: 3 };
const minute = 60_000;
const day = 24 * 60 * minute;

/**
 * Reads the time window and the number of failures from an OpenRCA
 * instruction, such as "On March 4, 2021, between 19:30 and 20:00, two
 * failures occurred." The window starts at the first `HH:MM` on the first date
 * and ends at the second `HH:MM`, on the next day when that time is not later.
 *
 * @throws Error if the instruction has no date, fewer than two times, or no
 *   number of failures.
 */
export function readWindow(instruction: string): Window {
  const date = new RegExp(`\\b(${months.join("|")}) (\\d{1,2}), (\\d{4})\\b`).exec(instruction);
  const [from, to] = instruction.match(/\b\d{2}:\d{2}\b/g) ?? [];
  const count =
    /\b(a|one|single|two|three|\d+)\s+(?:\w+\s+)?failures?\b/i.exec(instruction)?.[1] ??
    /\bnumber of failures\b[^.]*?\bis (\d+)\b/i.exec(instruction)?.[1];
  if (date === null || from === undefined || to === undefined || count === undefined) {
    throw new Error(`No time window or number of failures in: ${instruction}`);
  }
  const midnight = Date.UTC(
    Number(date[3]),
    months.findIndex((month) => month === date[1]),
    Number(date[2]),
  );
  const start = midnight + minutesOf(from) * minute;
  const end = midnight + minutesOf(to) * minute;
  return {
    start,
    end: end > start ? end : end + day,
    failures: counts[count.toLowerCase()] ?? Number(count),
  };
}

/**
 * Returns the agent's answer to `task`, one cause per failure, numbered from 1.
 * A cause has a component and a reason only if the task has candidates.
 *
 * @throws Error if the instruction has no time window or number of failures.
 */
export function answer(task: Task, seed: string): Record<string, Cause> {
  const { start, end, failures } = readWindow(task.instruction);
  const draw = uniform(`${seed}/${task.scenario}/${task.row}`);
  const pick = (names: readonly string[] = []) => names[Math.floor(draw() * names.length)];
  const minutes = (end - start) / minute;
  return Object.fromEntries(
    Array.from({ length: failures }, (_, i) => [
      String(i + 1),
      {
        "root cause occurrence datetime": datetime(start + Math.floor(draw() * minutes) * minute),
        "root cause component": pick(task.candidates?.components),
        "root cause reason": pick(task.candidates?.reasons),
      },
    ]),
  );
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function datetime(t: number): string {
  return new Date(t).toISOString().slice(0, 19).replace("T", " ");
}

function uniform(key: string): () => number {
  let counter = 0;
  return () => {
    const digest = createHash("sha256").update(`${key}/${counter++}`).digest();
    return digest.readUIntBE(0, 6) / 2 ** 48;
  };
}

if (import.meta.main) {
  const task: Task = JSON.parse(await readFile("/task.json", "utf8"));
  const prediction = answer(task, process.env.EVORCA_SEED ?? "");
  await writeFile("/out/prediction.json", JSON.stringify(prediction));
}
