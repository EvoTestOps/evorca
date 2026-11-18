/**
 * The summary of several finished `evorca evaluate` runs with the same
 * settings, which `evorca report` prints from the run folders and `evorca
 * evaluate --runs` prints after its last run. It reads `run.json` and
 * `scores.json` and never scores again. The tables are Markdown, so they read
 * in a terminal and paste into a document.
 *
 * @module
 */
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { openRcaScenarios, type OpenRcaScenario } from "@evorca/openrca";
import type { Summary } from "@evorca/openrca/scoring";
import { conflicts, isFinished, readRuns, type RunRecord } from "./runs.js";

type FinishedRun = {
  readonly record: RunRecord;
  readonly summary: Summary;
  readonly wallSeconds: number;
};

const levels = ["easy", "middle", "hard", "total"] as const;
const measures = ["strict", "partial"] as const;
const everyScenario = Object.keys(openRcaScenarios).filter(
  (key): key is OpenRcaScenario => key in openRcaScenarios,
);

/**
 * Prints the summary of the runs `runIds` for each of `scenarios` that one of
 * them covers. It leaves out each run that `isFinished` rejects, that has no
 * `scores.json`, or that does not cover the scenario, and names it. A
 * scenario's wall time runs to its end from the end of the scenario that ran
 * before it in the same run, or else from the run's start. It prints the
 * problem and returns false if a run is missing, if two runs of a scenario have
 * other settings, or if no run of a scenario is finished. The settings are
 * those that a resumed run keeps, except the seed. Otherwise it returns true.
 *
 * @throws Error if a `run.json` or a `scores.json` cannot be parsed.
 */
export async function reportRuns({
  runsDir,
  scenarios,
  runIds,
}: {
  readonly runsDir: string;
  readonly scenarios: readonly OpenRcaScenario[];
  readonly runIds: readonly string[];
}): Promise<boolean> {
  const runs = new Map<string, Map<OpenRcaScenario, RunRecord>>();
  for (const runId of runIds) runs.set(runId, await readRuns(runsDir, runId, everyScenario));
  const missing = [...runs].filter(([, run]) => run.size === 0).map(([runId]) => runId);
  if (missing.length > 0) {
    console.error(`No run ${missing.join(", ")} in ${relative(process.cwd(), runsDir)}.`);
    return false;
  }
  let reported = true;
  for (const scenario of scenarios) {
    const [first, ...others] = [...runs.values()].flatMap((run) => run.get(scenario) ?? []);
    if (first === undefined) continue;
    for (const other of others) {
      const problems = conflicts(other, {
        agent: first.agent,
        rows: first.rows,
        model: first.model,
      });
      if (problems.length > 0) {
        console.error(`Run ${other.runId} has other settings than run ${first.runId}:`);
        for (const problem of problems) console.error(`  ${problem}`);
        return false;
      }
    }
    const finished: FinishedRun[] = [];
    const unfinished: string[] = [];
    const absent: string[] = [];
    for (const [runId, run] of runs) {
      const record = run.get(scenario);
      if (record === undefined) {
        absent.push(runId);
        continue;
      }
      const path = join(runsDir, scenario, runId, "scores.json");
      const scores = await readFile(path, "utf8").catch(() => undefined);
      if (!isFinished(record) || scores === undefined) {
        unfinished.push(runId);
        continue;
      }
      const end = Date.parse(record.endedAt);
      const ends = [...run.values()].flatMap(({ endedAt }) =>
        endedAt === null ? [] : [Date.parse(endedAt)],
      );
      const start = Math.max(Date.parse(record.startedAt), ...ends.filter((time) => time < end));
      finished.push({
        record,
        summary: JSON.parse(scores).summary,
        wallSeconds: (end - start) / 1000,
      });
    }
    const [head] = finished;
    if (head === undefined) {
      console.error(`${scenario}: no run is finished. ${unfinished.join(", ")} can resume.`);
      reported = false;
    } else {
      printScenario(scenario, head, finished, unfinished, absent);
    }
  }
  return reported;
}

function printScenario(
  scenario: OpenRcaScenario,
  { record, summary }: FinishedRun,
  finished: readonly FinishedRun[],
  unfinished: readonly string[],
  absent: readonly string[],
) {
  const { agent, model, rows } = record;
  const settings = [
    agent.name,
    ...(model === null ? [] : [`${model.id} at effort ${model.effort}`]),
    ...(rows === null ? [] : [`rows ${rows.join(",")}`]),
  ].join(", ");
  const count = `${finished.length} ${finished.length === 1 ? "run" : "runs"}`;
  console.log(`\n${scenario}: ${count} of ${settings}`);
  if (unfinished.length > 0) console.log(`Left out, unfinished: ${unfinished.join(", ")}`);
  if (absent.length > 0) console.log(`Left out, without ${scenario}: ${absent.join(", ")}`);

  console.log("");
  printTable(
    ["Accuracy (%)", "Tasks", "Mean", "SD", "Min", "Max"],
    levels.flatMap((level) =>
      measures.map((measure) => {
        const { mean, sd, min, max } = spread(finished.map((run) => run.summary[level][measure]));
        const tasks = String(summary[level].tasks);
        return [`${level} ${measure}`, tasks, ...[mean, sd, min, max].map(percent)];
      }),
    ),
  );

  const usages = finished.flatMap((run) => run.record.usage ?? []);
  const priced = usages.length === finished.length;
  const requests = usages.reduce((total, usage) => total + usage.requests, 0);
  const cost = usages.reduce((total, usage) => total + usage.costUsd, 0);
  const seconds = finished.reduce((total, run) => total + run.wallSeconds, 0);
  const resumed = finished.some((run) => run.record.resumes.length > 0);
  console.log("");
  printTable(
    ["Run", "Seed", "Strict (%)", "Partial (%)", "Requests", "Cost (USD)", "Wall time"],
    [
      ...finished.map((run) => [
        run.record.runId,
        String(run.record.seed),
        percent(run.summary.total.strict),
        percent(run.summary.total.partial),
        run.record.usage === null ? "-" : String(run.record.usage.requests),
        run.record.usage === null ? "-" : run.record.usage.costUsd.toFixed(4),
        `${duration(run.wallSeconds)}${run.record.resumes.length > 0 ? "*" : ""}`,
      ]),
      [
        "Mean",
        "",
        "",
        "",
        priced ? (requests / finished.length).toFixed(1) : "-",
        priced ? (cost / finished.length).toFixed(4) : "-",
        duration(seconds / finished.length),
      ],
      [
        "Total",
        "",
        "",
        "",
        priced ? String(requests) : "-",
        priced ? cost.toFixed(4) : "-",
        duration(seconds),
      ],
    ],
  );
  if (resumed) console.log("\n* Resumed, so the wall time includes the time between sessions.");
}

function spread(values: readonly number[]) {
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const squares = values.reduce((total, value) => total + (value - mean) ** 2, 0);
  return {
    mean,
    sd: values.length > 1 ? Math.sqrt(squares / (values.length - 1)) : undefined,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function percent(fraction: number | undefined): string {
  return fraction === undefined ? "-" : (fraction * 100).toFixed(2);
}

function duration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = String(Math.floor(whole / 60) % 60).padStart(2, "0");
  return `${Math.floor(whole / 3600)}:${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function printTable(header: readonly string[], rows: readonly (readonly string[])[]) {
  const widths = header.map((cell, column) =>
    Math.max(3, cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]) => {
    const padded = widths.map((width, column) => {
      const cell = cells[column] ?? "";
      return column === 0 ? cell.padEnd(width) : cell.padStart(width);
    });
    return `| ${padded.join(" | ")} |`;
  };
  console.log(line(header));
  console.log(line(widths.map((width, column) => (column === 0 ? "-" : ":").padStart(width, "-"))));
  for (const row of rows) console.log(line(row));
}
