import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { parsePrediction } from "../../../packages/openrca/src/prediction.ts";
import { runTask, shellEnvironment, type Config } from "../src/main.ts";
import type { Limits } from "../src/prompt.ts";
import type { Task } from "../src/task.ts";
import { prices } from "../src/usage.ts";
import {
  apiError,
  bashCall,
  message,
  startMockApi,
  submitCall,
  thought,
  toolUse,
  type MockApi,
  type Reply,
} from "./mock-api.ts";

const task: Task = {
  scenario: "telecom",
  row: 4,
  taskIndex: "task_7",
  instruction: "On April 11, 2020, between 00:00 and 00:30, a failure occurred.",
  candidates: { components: ["os_001", "docker_003"], reasons: ["CPU fault", "network delay"] },
};
const sonnet = prices["claude-sonnet-5"] ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
const config: Config = { model: "claude-sonnet-5", prices: sonnet, effort: "high", seed: "7" };
const limits: Limits = { maxSteps: 50, commandTimeoutSeconds: 10, outputChars: 2_000 };
const answer = {
  occurrence_datetime: "2020-04-11 00:05:00",
  component: "docker_003",
  reason: "CPU fault",
};
const expectedPrediction =
  '{"1":{"root cause occurrence datetime":"2020-04-11 00:05:00","root cause component":"docker_003","root cause reason":"CPU fault"}}';

type Request = {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: unknown;
  readonly tools: unknown;
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
  readonly [key: string]: unknown;
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function run(
  replies: readonly Reply[],
  options: {
    config?: Partial<Config>;
    limits?: Partial<Limits>;
    now?: (mock: MockApi) => number;
  } = {},
) {
  const mock = await startMockApi(replies);
  const dir = await mkdtemp(join(tmpdir(), "evorca-react-"));
  cleanups.push(mock.close, () => rm(dir, { recursive: true, force: true }));
  const outDir = join(dir, "out");
  const shellCwd = join(dir, "tmp");
  await Promise.all(
    [outDir, shellCwd].map((path) => import("node:fs/promises").then((fs) => fs.mkdir(path))),
  );
  const summary = await runTask({
    task,
    config: { ...config, ...options.config },
    client: new Anthropic({ apiKey: "task-token", baseURL: mock.url, maxRetries: 0 }),
    outDir,
    shellCwd,
    shellEnv: shellEnvironment({ ...process.env, ANTHROPIC_API_KEY: "secret", EVORCA_MODEL: "x" }),
    limits: { ...limits, ...options.limits },
    ...(options.now === undefined ? {} : { now: () => options.now?.(mock) ?? 0 }),
  });
  const read = (file: string) => readFile(join(outDir, file), "utf8");
  const prediction = existsSync(join(outDir, "prediction.json"))
    ? await read("prediction.json")
    : undefined;
  const trajectory = (await read("trajectory.jsonl"))
    .trim()
    .split("\n")
    .map((line): Record<string, unknown> => JSON.parse(line));
  const requests = mock.requests.map((body): Request => JSON.parse(body));
  return {
    summary,
    savedSummary: JSON.parse(await read("summary.json")),
    prediction,
    trajectory,
    requests,
    rawRequests: mock.requests,
    headers: mock.headers,
    shellCwd,
  };
}

const lastUserContent = (request: Request | undefined) => request?.messages.at(-1)?.content;

describe("the ReAct loop", () => {
  it("runs commands until the model submits, and writes the three files", async () => {
    const result = await run([
      message([...thought("Let me look."), bashCall("echo hello > note.txt; cat note.txt")], {
        usage: { input_tokens: 3000, output_tokens: 200, cache_creation_input_tokens: 5000 },
      }),
      message(
        [bashCall('cat note.txt; echo "key=$ANTHROPIC_API_KEY model=${EVORCA_MODEL:-unset}"')],
        {
          usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 8000 },
        },
      ),
      message([...thought("Found it."), submitCall([answer])], {
        usage: { input_tokens: 50, output_tokens: 300, cache_read_input_tokens: 8200 },
      }),
    ]);

    expect(result.prediction).toBe(expectedPrediction);
    expect(parsePrediction(result.prediction ?? "")).toEqual([
      {
        occurredAt: Date.UTC(2020, 3, 10, 16, 5) / 1000,
        component: "docker_003",
        reason: "CPU fault",
      },
    ]);
    expect(lastUserContent(result.requests[1])).toEqual([
      expect.objectContaining({ type: "tool_result", content: "hello\n", is_error: false }),
    ]);
    expect(lastUserContent(result.requests[2])).toEqual([
      expect.objectContaining({ content: "hello\nkey= model=unset\n" }),
    ]);
    const usage = {
      input_tokens: 3100,
      output_tokens: 600,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 16200,
    };
    expect(result.summary).toMatchObject({
      stopCause: "submitted",
      answer: "submitted",
      wrapUp: null,
      steps: 3,
      turns: 3,
      usage,
      model: "claude-sonnet-5",
      effort: "high",
      seed: "7",
      maxSteps: 50,
      budgetUsd: null,
    });
    expect(result.summary.estimatedCostUsd).toBeCloseTo(
      (3100 * 2 + 600 * 10 + 5000 * 2.5 + 16200 * 0.2) / 1e6,
      10,
    );
    expect(result.savedSummary).toEqual(JSON.parse(JSON.stringify(result.summary)));
    expect(result.trajectory.map((event) => event.type)).toEqual([
      "task",
      "user",
      "response",
      "tool",
      "response",
      "tool",
      "response",
      "tool",
    ]);
    expect(result.trajectory[0]).toMatchObject({ promptSha256: result.summary.promptSha256 });
    expect(result.trajectory[3]).toMatchObject({
      name: "bash",
      step: 1,
      input: { command: "echo hello > note.txt; cat note.txt" },
      output: "hello\n",
      isError: false,
      end: { kind: "finished", exitCode: 0 },
    });
    expect(result.trajectory[2]).toMatchObject({
      turn: 1,
      maxTokens: 16000,
      message: { stop_reason: "tool_use", usage: { input_tokens: 3000 } },
    });
  });

  it("sends the same system prompt and tools every turn and only appends to the history", async () => {
    const result = await run([
      message([bashCall("echo one")]),
      message([...thought("Next."), bashCall("echo two"), bashCall("echo three")]),
      message([submitCall([answer])]),
    ]);

    expect(result.requests).toHaveLength(3);
    const prefix = (body: string) => body.slice(0, body.indexOf('"messages":'));
    for (const body of result.rawRequests) {
      expect(JSON.stringify(JSON.parse(body).system)).toBe(
        JSON.stringify(result.requests[0]?.system),
      );
      expect(JSON.stringify(JSON.parse(body).tools)).toBe(
        JSON.stringify(result.requests[0]?.tools),
      );
    }
    expect(new Set(result.rawRequests.map(prefix)).size).toBe(1);
    for (const [i, request] of result.requests.entries()) {
      const next = result.requests[i + 1];
      if (next !== undefined)
        expect(next.messages.slice(0, request.messages.length)).toEqual(request.messages);
      expect(request).toMatchObject({
        model: "claude-sonnet-5",
        max_tokens: 16000,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", cache_control: { type: "ephemeral" } }],
      });
      for (const key of ["temperature", "top_p", "top_k", "tool_choice", "stream"]) {
        expect(request).not.toHaveProperty(key);
      }
    }
    expect(result.requests[0]?.messages).toEqual([
      {
        role: "user",
        content: `The issue you are going to solve is:\n\n${task.instruction}\n\nSolve the issue step-by-step.`,
      },
    ]);
    expect(lastUserContent(result.requests[2])).toEqual([
      expect.objectContaining({ type: "tool_result", content: "two\n" }),
      expect.objectContaining({ type: "tool_result", content: "three\n" }),
    ]);
  });

  it("wraps up at the step cap and refuses further commands", async () => {
    const result = await run(
      [
        message([bashCall("echo 1 >> runs")]),
        message([bashCall("echo 2 >> runs"), bashCall("echo 3 >> runs")]),
        message([bashCall("echo 4 >> runs")]),
        message([submitCall([answer])]),
      ],
      { limits: { maxSteps: 2 } },
    );

    expect(await readFile(join(result.shellCwd, "runs"), "utf8")).toBe("1\n2\n");
    const wrapUp = {
      type: "text",
      text: "You have made all 2 tool calls. Call submit_answer now with your best answer from what you have found so far. You cannot run more commands.",
    };
    expect(lastUserContent(result.requests[2])).toEqual([
      expect.objectContaining({ content: "(no output)", is_error: false }),
      expect.objectContaining({
        content: "Not run: you cannot run more commands. Call submit_answer now.",
        is_error: true,
      }),
      wrapUp,
    ]);
    expect(lastUserContent(result.requests[3])).toEqual([
      expect.objectContaining({ is_error: true }),
      wrapUp,
    ]);
    expect(result.summary).toMatchObject({
      stopCause: "submitted",
      wrapUp: "steps",
      steps: 3,
      turns: 4,
    });
    expect(result.prediction).toBe(expectedPrediction);
  });

  it("gives up after two responses without an answer once it wraps up", async () => {
    const result = await run(
      [
        message([bashCall("true")]),
        message(thought("I think..."), { stopReason: "end_turn" }),
        message(thought("Still thinking."), { stopReason: "end_turn" }),
      ],
      { limits: { maxSteps: 1 } },
    );

    expect(result.summary).toMatchObject({
      stopCause: "no-answer",
      answer: "none",
      wrapUp: "steps",
      turns: 3,
    });
    expect(result.prediction).toBeUndefined();
  });

  it("wraps up at the soft budget before running the turn's commands", async () => {
    const result = await run(
      [
        message([bashCall("echo ran > spent")], { usage: { output_tokens: 85_000 } }),
        message([submitCall([answer])]),
      ],
      { config: { budgetUsd: 1 } },
    );

    expect(existsSync(join(result.shellCwd, "spent"))).toBe(false);
    expect(lastUserContent(result.requests[1])).toEqual([
      expect.objectContaining({ is_error: true }),
      {
        type: "text",
        text: "Your budget for this issue is almost spent. Call submit_answer now with your best answer from what you have found so far. You cannot run more commands.",
      },
    ]);
    expect(result.summary).toMatchObject({
      stopCause: "submitted",
      wrapUp: "budget",
      budgetUsd: 1,
      softBudgetUsd: 0.8,
      steps: 1,
    });
  });

  it("wraps up at the soft deadline", async () => {
    const result = await run(
      [message([bashCall("echo late > late")]), message([submitCall([answer])])],
      {
        config: { timeoutSeconds: 100 },
        now: (mock) => (mock.requests.length === 0 ? 0 : 90_000),
      },
    );

    expect(existsSync(join(result.shellCwd, "late"))).toBe(false);
    expect(result.summary).toMatchObject({ stopCause: "submitted", wrapUp: "time" });
    expect(JSON.stringify(lastUserContent(result.requests[1]))).toContain(
      "Your time for this issue is almost up.",
    );
  });

  it("keeps the valid fields of a rejected answer when the budget runs out", async () => {
    const result = await run([
      message([submitCall([{ ...answer, occurrence_datetime: "2020-04-11T00:05" }])]),
      apiError(403, "evorca_budget_exhausted", "The task's budget is spent."),
    ]);

    expect(result.summary).toMatchObject({
      stopCause: "budget-exhausted",
      answer: "partial",
      error: { status: 403, errorType: "evorca_budget_exhausted" },
    });
    expect(result.prediction).toBe(
      '{"1":{"root cause component":"docker_003","root cause reason":"CPU fault"}}',
    );
    expect(result.trajectory.at(-1)).toMatchObject({ type: "api-error", status: 403 });
  });

  it("writes no prediction when the budget runs out before any answer", async () => {
    const result = await run([
      message([bashCall("true")]),
      apiError(403, "evorca_budget_exhausted"),
    ]);

    expect(result.summary).toMatchObject({
      stopCause: "budget-exhausted",
      answer: "none",
      steps: 1,
    });
    expect(result.prediction).toBeUndefined();
  });

  it("ends on another API error", async () => {
    const result = await run([apiError(400, "invalid_request_error", "messages: bad")]);

    expect(result.summary).toMatchObject({
      stopCause: "api-error",
      error: { status: 400, errorType: "invalid_request_error" },
      turns: 0,
    });
  });

  it("asks again with a larger output limit after max_tokens, without running the cut-off call", async () => {
    const result = await run([
      message([...thought("A long thought"), toolUse("bash", { command: "echo cut > cut" })], {
        stopReason: "max_tokens",
      }),
      message([submitCall([answer])]),
    ]);

    expect(existsSync(join(result.shellCwd, "cut"))).toBe(false);
    expect(result.requests.map((request) => request.max_tokens)).toEqual([16000, 32000]);
    expect(result.requests[1]?.messages).toEqual(result.requests[0]?.messages);
    expect(result.summary).toMatchObject({ stopCause: "submitted", turns: 2 });
  });

  it("waits longer for each response than the model proxy's 15 minutes", async () => {
    const result = await run([
      message(thought("A long thought"), { stopReason: "max_tokens" }),
      message([submitCall([answer])]),
    ]);

    expect(result.headers.map((headers) => Number(headers["x-stainless-timeout"]))).toEqual([
      960, 960,
    ]);
  });

  it("stops when the largest output limit is not enough", async () => {
    const cut = message(thought("Endless"), { stopReason: "max_tokens" });
    const result = await run([cut, cut]);

    expect(result.summary).toMatchObject({ stopCause: "max-tokens", answer: "none", turns: 2 });
  });

  it("asks once for an answer when the model stops without one, then gives up", async () => {
    const result = await run([
      message(thought("The root cause is docker_003."), { stopReason: "end_turn" }),
      message(thought("As I said, docker_003."), { stopReason: "end_turn" }),
    ]);

    expect(lastUserContent(result.requests[1])).toEqual([
      {
        type: "text",
        text: "You ended your turn without calling submit_answer. Call submit_answer now with your answer, or continue the investigation with bash if you need more evidence.",
      },
    ]);
    expect(result.summary).toMatchObject({ stopCause: "no-answer", answer: "none" });
    expect(result.prediction).toBeUndefined();
  });

  it("sends no empty assistant message after an empty response", async () => {
    const result = await run([
      message([], { stopReason: "end_turn" }),
      message([submitCall([answer])]),
    ]);

    expect(result.requests[1]?.messages.map((entry) => entry.role)).toEqual(["user", "user"]);
    expect(result.summary).toMatchObject({ stopCause: "submitted" });
  });

  it("accepts an answer after the nudge", async () => {
    const result = await run([
      message(thought("Done."), { stopReason: "end_turn" }),
      message([submitCall([answer])]),
    ]);

    expect(result.summary).toMatchObject({ stopCause: "submitted" });
    expect(result.prediction).toBe(expectedPrediction);
  });

  it("returns a malformed answer to the model and accepts the corrected one", async () => {
    const result = await run([
      message([submitCall([{ ...answer, reason: null }])]),
      message([submitCall([answer])]),
    ]);

    expect(lastUserContent(result.requests[1])).toEqual([
      expect.objectContaining({
        type: "tool_result",
        is_error: true,
        content:
          "Your answer was not accepted:\n- Root cause 1 has no reason, which the issue asks for.\nCall submit_answer again with a corrected answer.",
      }),
    ]);
    expect(result.summary).toMatchObject({ stopCause: "submitted", steps: 2 });
    expect(result.prediction).toBe(expectedPrediction);
  });

  it("records a refusal and stops", async () => {
    const result = await run([
      message([], {
        stopReason: "refusal",
        stopDetails: { type: "refusal", category: null, explanation: null },
      }),
    ]);

    expect(result.summary).toMatchObject({
      stopCause: "refusal",
      answer: "none",
      refusal: { type: "refusal" },
    });
  });

  it("restarts the bash session on request", async () => {
    const result = await run([
      message([bashCall("export MARK=set")]),
      message([toolUse("bash", { restart: true })]),
      message([bashCall('echo "mark=$MARK"')]),
      message([submitCall([answer])]),
    ]);

    expect(lastUserContent(result.requests[2])).toEqual([
      expect.objectContaining({ content: "The bash session was restarted." }),
    ]);
    expect(lastUserContent(result.requests[3])).toEqual([
      expect.objectContaining({ content: "mark=\n" }),
    ]);
  });
});
