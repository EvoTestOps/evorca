/**
 * The agent's prompt for a task: the system prompt, the tools, and the first
 * user message.
 *
 * The domain knowledge in the system prompt is RCA-Agent's, from
 * `background.json`, which `scripts/extract-background.ts` writes from
 * OpenRCA's prompts. The rest of the system prompt describes the container,
 * the tools, and how the answer is scored. It names no component, KPI, or
 * failure beyond what RCA-Agent's prompts name.
 *
 * The system prompt and the tools depend only on the scenario, its candidates,
 * and the limits, so every request of a task, and every task of a scenario,
 * starts with the same bytes, which prompt caching needs. The issue goes in the
 * first user message.
 *
 * @module
 */
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { submitAnswerTool } from "./answer.ts";
import type { Candidates, Task } from "./task.ts";

/**
 * RCA-Agent's domain knowledge for one scenario. `schema` describes the
 * telemetry and holds a `{cand}` placeholder where RCA-Agent's prompt lists
 * the candidates. `cand` is that list as RCA-Agent writes it, and `candidates`
 * holds its entries.
 */
export type ScenarioBackground = {
  readonly schema: string;
  readonly cand: string;
  readonly candidates: Candidates;
};

/** RCA-Agent's domain knowledge: its rules, and the background of each scenario. */
export type Background = {
  readonly source: string;
  readonly rules: string;
  readonly scenarios: Readonly<Record<string, ScenarioBackground>>;
};

/** The limits that the agent works within, which the system prompt states. */
export type Limits = {
  readonly maxSteps: number;
  readonly commandTimeoutSeconds: number;
  readonly outputChars: number;
};

/** The parts of a request that stay the same for a whole task. */
export type Prompt = {
  readonly system: string;
  readonly tools: readonly Anthropic.Messages.ToolUnion[];
  readonly instruction: string;
  readonly sha256: string;
};

/** The name of the bash tool. */
export const bash = "bash";

const placeholder = "{cand}";

/**
 * Builds the prompt for `task`. With candidates equal to RCA-Agent's, the
 * system prompt lists them as RCA-Agent's prompt does. With other candidates,
 * it lists those, and without candidates it lists none.
 *
 * @throws Error if `background` has no scenario named like the task's.
 */
export function buildPrompt(task: Task, background: Background, limits: Limits): Prompt {
  const scenario = background.scenarios[task.scenario];
  if (scenario === undefined) throw new Error(`No background for scenario ${task.scenario}`);
  const cand = candidatesSection(task.candidates, scenario);
  const domain =
    cand === undefined
      ? scenario.schema.replace(`\n\n${placeholder}\n\n`, "\n\n")
      : scenario.schema.replace(placeholder, cand);
  const system = [
    intro,
    environment(limits),
    "There is some domain knowledge for you:",
    domain,
    background.rules,
    answer(task.candidates !== undefined),
  ].join("\n\n");
  const tools = [{ type: "bash_20250124", name: bash } as const, submitAnswerTool(task.candidates)];
  const instruction = `The issue you are going to solve is:\n\n${task.instruction}\n\nSolve the issue step-by-step.`;
  const sha256 = createHash("sha256").update(JSON.stringify({ system, tools })).digest("hex");
  return { system, tools, instruction, sha256 };
}

function candidatesSection(
  candidates: Candidates | undefined,
  scenario: ScenarioBackground,
): string | undefined {
  if (candidates === undefined) return undefined;
  if (sameCandidates(candidates, scenario.candidates)) return scenario.cand;
  const list = (names: readonly string[]) => names.map((name) => `- ${name}`).join("\n");
  return `## POSSIBLE ROOT CAUSE COMPONENTS:\n\n${list(candidates.components)}\n\n## POSSIBLE ROOT CAUSE REASONS:\n\n${list(candidates.reasons)}`;
}

function sameCandidates(a: Candidates, b: Candidates): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((name, i) => name === y[i]);
  return same(a.components, b.components) && same(a.reasons, b.reasons);
}

const intro =
  "You are a DevOps assistant for failure diagnosis. To solve the given issue, you analyze the telemetry files of the target system by running commands with the bash tool, and you approximate the answer step-by-step from the results. When you have found the root causes, you report them with the submit_answer tool.";

function environment(limits: Limits): string {
  return `## YOUR ENVIRONMENT

- The bash tool runs commands in a Linux container without network access. The bash session keeps its working directory, variables, and files between calls. Each \`python3\` call is a new process, so Python variables do not persist: save results that you want to reuse to files in \`/tmp/\`.
- The telemetry directory is \`/data/\`, which is read-only. \`/tmp/\` is writable, and the bash session starts there. Files in \`/tmp/\` count toward your memory limit.
- Python 3 is installed with pandas, pytz, and DuckDB.
- Some telemetry files are larger than 1 GB, more than fits in your memory. Query large CSV files with DuckDB, which streams them from disk, and load only the rows or aggregates that you need into pandas. For example: \`python3 -c "import duckdb; duckdb.sql(\\"SELECT cmdb_id, count(*) FROM read_csv('/data/<date>/metric/<file>.csv') GROUP BY cmdb_id\\").show()"\`. DuckDB sets its memory limit and its threads from the container's limits, and it spills to \`.tmp/\` in the working directory, so run it from \`/tmp/\`.
- A command that runs longer than ${limits.commandTimeoutSeconds} seconds is stopped, and the bash session restarts: its working directory and variables are lost, but files remain.
- Output longer than ${limits.outputChars} characters is cut in the middle, so print only what you need.
- You can make at most ${limits.maxSteps} tool calls. After the last one, you can only submit your answer.`;
}

function answer(withCandidates: boolean): string {
  const select = withCandidates
    ? [
        "- Select each root cause component and reason from the possible root cause components and reasons above.",
      ]
    : [];
  return [
    "## YOUR ANSWER",
    "",
    "Call submit_answer once, when you have found the root causes. It ends your investigation.",
    "",
    "- Give one root cause per failure, as many as the issue says occurred.",
    "- Give only the fields that the issue asks for, and set the others to null.",
    "- Give the root cause occurrence datetime in UTC+8, in the format `YYYY-MM-DD HH:MM:SS`.",
    ...select,
    "- Do not be too conservative in selecting the root cause components and reasons. Be decisive to infer a possible answer based on your current observation.",
    "",
    "The answer is scored field by field. A datetime is correct within one minute of the true root cause occurrence time, and a component or a reason is correct only if it is exactly the true one. If the number of root causes differs from the number of failures, every field scores zero. The order of the root causes does not matter.",
  ].join("\n");
}
