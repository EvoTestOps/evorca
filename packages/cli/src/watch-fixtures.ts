/**
 * Test fixtures for `evorca watch`: run records, task records, trajectory
 * lines as the `react` agent writes them, and a run folder on disk that a
 * test can grow the way `evorca evaluate` does.
 *
 * @module
 */
import { appendFile, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pinnedInputs } from "@evorca/openrca/scoring";
import { agents } from "./agents.js";
import { noUsage } from "./models.js";
import { taskDirOf, type ModelSettings, type RunRecord, type TaskRecord } from "./runs.js";

const { jobs: _, ...react } = agents.react;
const model: ModelSettings = {
  id: "claude-sonnet-5",
  effort: "high",
  taskBudgetUsd: 2,
  upstreamUrl: "https://api.anthropic.com",
  prices: {
    table: "anthropic-2026-11-17",
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    checkedAt: "2026-11-17",
    usdPerMTok: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  },
};

/** A run of the `react` agent on `telecom` that has started and has no task done. */
export function runRecord(changes: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "20261118T094052Z-react",
    benchmark: "openrca",
    scenario: "telecom",
    agent: { name: "react", ...react, image: "evorca-agent-react:abc", imageId: "sha256:1" },
    seed: 7,
    rows: null,
    model,
    budgetUsd: 50,
    jobs: 2,
    git: { commit: "abc", dirty: false },
    pinnedInputs,
    versions: { node: "v26.13.1", docker: { client: "28.2.2", server: "28.2.2" } },
    startedAt: "2026-11-18T09:40:00.000Z",
    resumes: [],
    endedAt: null,
    tasks: [],
    abandoned: [],
    usage: noUsage,
    ...changes,
  };
}

/** The record of the task on `row` with `outcome`, after `seconds` and at a cost of `costUsd`. */
export function taskRecord(
  row: number,
  outcome: TaskRecord["outcome"],
  seconds: number,
  costUsd = 0,
): TaskRecord {
  const usage = { ...noUsage, requests: 1, costUsd };
  return { row, taskIndex: "task_2", outcome, exitCode: 0, seconds, usage };
}

/** A line of `trajectory.jsonl` of type `type`, logged at `09:<time>` UTC on the day of the run. */
export function event(type: string, time: string, fields: object): string {
  return `${JSON.stringify({ at: `2026-11-18T09:${time}.000Z`, type, ...fields })}\n`;
}

/** A model response of turn `turn` with the content blocks `content`, 2.5 s and $0.0125. */
export function response(time: string, turn: number, content: readonly object[]): string {
  const message = { role: "assistant", content };
  return event("response", time, {
    turn,
    maxTokens: 32000,
    seconds: 2.5,
    costUsd: 0.0125,
    message,
  });
}

/** A `bash` call with the ID `id` and its command. */
export function bash(id: string, command: string): object {
  return { type: "tool_use", id, name: "bash", input: { command } };
}

/** The result of the tool call with the ID `id`. */
export function tool(time: string, id: string, output: string, isError = false): string {
  return event("tool", time, {
    step: 1,
    id,
    name: "bash",
    input: {},
    output,
    isError,
    seconds: 0.5,
  });
}

/** The first line of a trajectory, with the instruction of the task. */
export function taskEvent(time: string, instruction: string): string {
  return event("task", time, { task: { row: 0, taskIndex: "task_2", instruction } });
}

/**
 * A folder of runs in the temporary folder, which the test grows with the
 * same writes as `evorca evaluate` and the agent: `run.json` by rename, and
 * the logs of a task by append.
 */
export async function runsFolder() {
  const runsDir = await mkdtemp(join(tmpdir(), "evorca-watch-"));
  const runDir = (record: RunRecord) => join(runsDir, record.scenario, record.runId);
  return {
    runsDir,
    async writeRun(record: RunRecord) {
      await mkdir(runDir(record), { recursive: true });
      const path = join(runDir(record), "run.json");
      await writeFile(`${path}.tmp`, JSON.stringify(record));
      await rename(`${path}.tmp`, path);
    },
    async startTask(record: RunRecord, row: number) {
      await mkdir(taskDirOf(runDir(record), row), { recursive: true });
    },
    async append(record: RunRecord, row: number, file: "trajectory" | "requests", text: string) {
      const name = file === "trajectory" ? join("out", "trajectory.jsonl") : "requests.jsonl";
      const path = join(taskDirOf(runDir(record), row), name);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text);
    },
    async writeScores(record: RunRecord, strict: number, partial: number) {
      const accuracy = { tasks: 1, strict, partial };
      const summary = { easy: accuracy, middle: accuracy, hard: accuracy, total: accuracy };
      await writeFile(join(runDir(record), "scores.json"), JSON.stringify({ summary, scores: [] }));
    },
  };
}
