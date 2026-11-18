/**
 * The ReAct loop: the model reasons, calls a tool, reads the result, and
 * repeats until it submits an answer.
 *
 * Each request sends the same system prompt and tools and appends to the same
 * history, so the cache serves every earlier turn. The system prompt carries a
 * cache breakpoint of its own, which the next task of the scenario reads, and
 * the request's automatic breakpoint follows the end of the history.
 *
 * The loop is in one of two phases. While investigating, the model may run
 * commands. A model that ends its turn without a tool call is asked once to
 * submit, and the loop gives up the second time. When the model has made its
 * last allowed tool call, has spent the soft budget, or is past the soft
 * deadline, the loop wraps up: it asks for the answer and refuses commands,
 * and it gives up after two more responses without a valid answer.
 *
 * A response cut off at `max_tokens` is discarded and asked again with the
 * next larger limit, because its last block may be an incomplete tool call. A
 * refusal ends the loop. So does an API error that the SDK gives up on, such
 * as the model proxy's `evorca_budget_exhausted` 403, after which no model is
 * left to ask. Every outcome keeps the best answer so far: the submitted one,
 * or the valid fields of the last rejected one that had any.
 *
 * @module
 */
import Anthropic, { APIError, PermissionDeniedError } from "@anthropic-ai/sdk";
import { readAnswer, submitAnswer, type Cause } from "./answer.ts";
import { describeResult, type BashSession, type CommandEnd } from "./bash.ts";
import { bash, type Limits, type Prompt } from "./prompt.ts";
import { isRecord, type Task } from "./task.ts";
import { addUsage, costUsd, noUsage, type Prices, type Usage } from "./usage.ts";

/** The effort levels of `output_config.effort`. */
export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

/** One effort level. */
export type Effort = (typeof efforts)[number];

/**
 * How the loop calls the model. `maxTokens` lists the output limits to try in
 * order, the next one after a response stops at `max_tokens`. `softBudgetUsd`
 * and `deadline`, a time in milliseconds since the epoch, start the wrap-up.
 */
export type Settings = {
  readonly model: string;
  readonly effort: Effort;
  readonly prices: Prices;
  readonly maxTokens: readonly [number, ...number[]];
  readonly softBudgetUsd?: number;
  readonly deadline?: number;
};

/** Why the loop began to wrap up. */
export type WrapUpReason = "steps" | "budget" | "time";

/** Why the loop ended. */
export type StopCause =
  | "submitted"
  | "no-answer"
  | "budget-exhausted"
  | "refusal"
  | "max-tokens"
  | "context-window"
  | "api-error";

/** An API error that ended the loop. */
export type ApiErrorSummary = {
  readonly status: number | undefined;
  readonly errorType: string | null;
  readonly message: string;
};

/**
 * How the loop ended. `causes` is the submitted answer, or else the valid
 * fields of the last rejected one that had any, or else empty. `steps` counts
 * the tool calls that ran, and `turns` the model responses, discarded ones
 * included.
 */
export type Outcome = {
  readonly stopCause: StopCause;
  readonly wrapUp: WrapUpReason | null;
  readonly answer: "submitted" | "partial" | "none";
  readonly causes: readonly Cause[];
  readonly steps: number;
  readonly turns: number;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly error?: ApiErrorSummary;
  readonly refusal?: Anthropic.Messages.RefusalStopDetails | null;
};

/** One entry of the trajectory, without its timestamp. */
export type Event =
  | { readonly type: "user"; readonly text: string }
  | {
      readonly type: "response";
      readonly turn: number;
      readonly maxTokens: number;
      readonly seconds: number;
      readonly costUsd: number;
      readonly message: Anthropic.Message;
    }
  | {
      readonly type: "tool";
      readonly step: number | null;
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly output: string;
      readonly isError: boolean;
      readonly seconds: number;
      readonly end?: CommandEnd;
    }
  | ({ readonly type: "api-error" } & ApiErrorSummary);

/** What {@link investigate} works with. `now` returns milliseconds since the epoch. */
export type LoopOptions = {
  readonly client: Anthropic;
  readonly prompt: Prompt;
  readonly task: Task;
  readonly shell: BashSession;
  readonly settings: Settings;
  readonly limits: Limits;
  readonly log: (event: Event) => void;
  readonly now?: () => number;
};

type Phase =
  | { readonly kind: "investigating"; readonly nudged: boolean }
  | { readonly kind: "wrapping-up"; readonly reason: WrapUpReason; readonly responsesLeft: number };

type ToolResult = { readonly output: string; readonly isError: boolean; readonly end?: CommandEnd };

const budgetExhausted = "evorca_budget_exhausted";
const wrapUpResponses = 2;

const nudge =
  "You ended your turn without calling submit_answer. Call submit_answer now with your answer, or continue the investigation with bash if you need more evidence.";

/** Runs the loop for one task until it ends, and returns how it ended. */
export async function investigate(options: LoopOptions): Promise<Outcome> {
  const { client, prompt, task, shell, settings, limits, log } = options;
  const now = options.now ?? Date.now;
  const messages: Anthropic.MessageParam[] = [];
  let phase: Phase = { kind: "investigating", nudged: false };
  let usage = noUsage;
  let steps = 0;
  let turns = 0;
  let partial: readonly Cause[] = [];

  const send = (results: Anthropic.ToolResultBlockParam[], text?: string) => {
    if (text !== undefined) log({ type: "user", text });
    const blocks = text === undefined ? results : [...results, { type: "text" as const, text }];
    messages.push({ role: "user", content: blocks });
  };
  const wrapUp = (reason: WrapUpReason): Phase => ({
    kind: "wrapping-up",
    reason,
    responsesLeft: wrapUpResponses,
  });
  const end = (stopCause: StopCause, extra: Partial<Outcome> = {}): Outcome => {
    const causes = extra.causes ?? partial;
    return {
      stopCause,
      wrapUp: phase.kind === "wrapping-up" ? phase.reason : null,
      answer: stopCause === "submitted" ? "submitted" : causes.length > 0 ? "partial" : "none",
      causes,
      steps,
      turns,
      usage,
      costUsd: costUsd(usage, settings.prices),
      ...extra,
    };
  };

  const respond = async (): Promise<Anthropic.Message> => {
    let message: Anthropic.Message | undefined;
    for (const maxTokens of settings.maxTokens) {
      const started = now();
      message = await client.messages.create(
        {
          model: settings.model,
          max_tokens: maxTokens,
          system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
          tools: [...prompt.tools],
          messages,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: settings.effort },
          cache_control: { type: "ephemeral" },
        },
        // Without a timeout, the SDK refuses a non-streaming request that it expects to take over
        // 10 minutes, at an hour per 128,000 max_tokens.
        { timeout: Math.max(10 * 60_000, (60 * 60_000 * maxTokens) / 128_000) },
      );
      turns += 1;
      usage = addUsage(usage, message.usage);
      log({
        type: "response",
        turn: turns,
        maxTokens,
        seconds: (now() - started) / 1000,
        costUsd: costUsd(addUsage(noUsage, message.usage), settings.prices),
        message,
      });
      if (message.stop_reason !== "max_tokens") break;
    }
    if (message === undefined) throw new Error("No output limit to try");
    return message;
  };

  const limitReached = (): WrapUpReason | undefined => {
    if (
      settings.softBudgetUsd !== undefined &&
      costUsd(usage, settings.prices) >= settings.softBudgetUsd
    ) {
      return "budget";
    }
    if (settings.deadline !== undefined && now() >= settings.deadline) return "time";
    return undefined;
  };

  const runBash = async (input: unknown): Promise<ToolResult> => {
    if (isRecord(input) && input.restart === true) {
      shell.restart();
      return { output: "The bash session was restarted.", isError: false };
    }
    if (!isRecord(input) || typeof input.command !== "string") {
      return { output: "The bash tool takes a command, or restart: true.", isError: true };
    }
    const result = await shell.run(input.command);
    return {
      output: describeResult(result, limits.commandTimeoutSeconds),
      isError: result.end.kind !== "finished",
      end: result.end,
    };
  };

  log({ type: "user", text: prompt.instruction });
  messages.push({ role: "user", content: prompt.instruction });

  for (;;) {
    let response: Anthropic.Message;
    try {
      response = await respond();
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      const summary: ApiErrorSummary = {
        status: error.status,
        errorType: error.type,
        message: error.message,
      };
      log({ type: "api-error", ...summary });
      return end(isBudgetExhausted(error) ? "budget-exhausted" : "api-error", { error: summary });
    }
    switch (response.stop_reason) {
      case "refusal":
        return end("refusal", { refusal: response.stop_details });
      case "max_tokens":
        return end("max-tokens");
      case "model_context_window_exceeded":
        return end("context-window");
    }
    // The API rejects an empty assistant message, and merges the user messages around a gap.
    if (response.content.length > 0)
      messages.push({ role: "assistant", content: response.content });

    const wasWrappingUp = phase.kind === "wrapping-up";
    if (phase.kind === "investigating") {
      const reason = limitReached();
      if (reason !== undefined) phase = wrapUp(reason);
    }
    const calls = response.content.filter((block) => block.type === "tool_use");
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const started = now();
      let step: number | null = null;
      let result: ToolResult;
      if (call.name === submitAnswer) {
        step = ++steps;
        const reading = readAnswer(call.input, task);
        if (reading.valid) {
          log(toolEvent(call, step, { output: "Accepted.", isError: false }, started, now()));
          return end("submitted", { causes: reading.causes });
        }
        if (reading.partial.length > 0) partial = reading.partial;
        result = {
          output: `Your answer was not accepted:\n${reading.problems.map((problem) => `- ${problem}`).join("\n")}\nCall submit_answer again with a corrected answer.`,
          isError: true,
        };
      } else if (call.name === bash && phase.kind === "investigating") {
        step = ++steps;
        result = await runBash(call.input);
      } else if (call.name === bash) {
        result = {
          output: "Not run: you cannot run more commands. Call submit_answer now.",
          isError: true,
        };
      } else {
        result = { output: `There is no tool named ${call.name}.`, isError: true };
      }
      log(toolEvent(call, step, result, started, now()));
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: result.output,
        is_error: result.isError,
      });
      if (phase.kind === "investigating" && steps >= limits.maxSteps) phase = wrapUp("steps");
    }

    if (phase.kind === "wrapping-up") {
      if (wasWrappingUp) {
        if (phase.responsesLeft <= 1) return end("no-answer");
        phase = { ...phase, responsesLeft: phase.responsesLeft - 1 };
      }
      send(results, wrapUpMessage(phase.reason, limits));
    } else if (calls.length === 0) {
      if (phase.nudged) return end("no-answer");
      phase = { kind: "investigating", nudged: true };
      send(results, nudge);
    } else {
      send(results);
    }
  }
}

function isBudgetExhausted(error: APIError): boolean {
  if (!(error instanceof PermissionDeniedError)) return false;
  const type: string | null = error.type;
  return type === budgetExhausted;
}

function toolEvent(
  call: Anthropic.ToolUseBlock,
  step: number | null,
  result: ToolResult,
  started: number,
  ended: number,
): Event {
  return {
    type: "tool",
    step,
    id: call.id,
    name: call.name,
    input: call.input,
    output: result.output,
    isError: result.isError,
    seconds: (ended - started) / 1000,
    ...(result.end === undefined ? {} : { end: result.end }),
  };
}

function wrapUpMessage(reason: WrapUpReason, limits: Limits): string {
  const why = {
    steps: `You have made all ${limits.maxSteps} tool calls.`,
    budget: "Your budget for this issue is almost spent.",
    time: "Your time for this issue is almost up.",
  }[reason];
  return `${why} Call submit_answer now with your best answer from what you have found so far. You cannot run more commands.`;
}
