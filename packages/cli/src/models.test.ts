import { describe, expect, it } from "vitest";
import {
  addUsage,
  costUsd,
  models,
  noUsage,
  tokensOf,
  usageOfLog,
  type RequestEntry,
  type Tokens,
} from "./models.js";

const prices = models["claude-sonnet-5"].usdPerMTok;
const none: Tokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
};

describe("models", () => {
  it("prices claude-sonnet-5 at $2 in, $10 out, and the cache at 1.25x, 2x, and 0.1x of input", () => {
    expect(prices).toEqual({
      input: 2,
      output: 10,
      cacheWrite5m: 2 * 1.25,
      cacheWrite1h: 2 * 2,
      cacheRead: 2 * 0.1,
    });
  });
});

describe("costUsd", () => {
  it.each<[string, Partial<Tokens>, number]>([
    ["a million input tokens", { inputTokens: 1e6 }, 2],
    ["a million output tokens", { outputTokens: 1e6 }, 10],
    ["a million five-minute cache writes", { cacheCreation5mInputTokens: 1e6 }, 2.5],
    ["a million one-hour cache writes", { cacheCreation1hInputTokens: 1e6 }, 4],
    ["a million cache reads", { cacheReadInputTokens: 1e6 }, 0.2],
  ])("costs %s at the table's price", (_, tokens, dollars) => {
    expect(costUsd({ ...none, ...tokens }, prices)).toBe(dollars);
  });

  it("adds up every kind of token in one request", () => {
    const tokens: Tokens = {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheCreation5mInputTokens: 40_000,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 500_000,
    };

    expect(costUsd(tokens, prices)).toBe(0.5);
  });

  it("does not drift when it adds many small requests", () => {
    const request = { kind: "forwarded", status: 200, seconds: 0.1 } as const;
    const log = Array.from({ length: 1000 }, () =>
      JSON.stringify({ ...request, tokens: { ...none, cacheReadInputTokens: 1 } }),
    ).join("\n");

    expect(usageOfLog(log, prices).costUsd).toBe(0.0002);
  });
});

describe("tokensOf", () => {
  it("reads the tokens of a response's usage, with cache writes split by lifetime", () => {
    const usage = {
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 700,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
    };

    expect(tokensOf(usage)).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheCreation5mInputTokens: 200,
      cacheCreation1hInputTokens: 300,
      cacheReadInputTokens: 700,
    });
  });

  it("counts cache writes as five-minute writes when usage does not split them", () => {
    const usage = { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 50 };

    expect(tokensOf(usage)).toMatchObject({
      cacheCreation5mInputTokens: 50,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it.each([undefined, null, "usage", { input_tokens: 1 }, { output_tokens: 1 }])(
    "reads no tokens from %j",
    (usage) => {
      expect(tokensOf(usage)).toBeUndefined();
    },
  );
});

describe("usageOfLog", () => {
  const entries: RequestEntry[] = [
    {
      kind: "forwarded",
      at: "2026-11-17T12:00:00.000Z",
      status: 200,
      seconds: 1.25,
      requestId: "req_1",
      error: null,
      tokens: { ...none, inputTokens: 250_000, outputTokens: 10_000 },
      costUsd: 0.6,
    },
    {
      kind: "forwarded",
      at: "2026-11-17T12:00:02.000Z",
      status: 529,
      seconds: 0.5,
      requestId: "req_2",
      error: "overloaded_error",
      tokens: null,
      costUsd: 0,
    },
    {
      kind: "denied",
      at: "2026-11-17T12:00:03.000Z",
      status: 403,
      error: "evorca_budget_exhausted",
    },
  ];
  const log = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

  it("counts requests, errors, denials, time, tokens, and cost", () => {
    expect(usageOfLog(log, prices)).toEqual({
      ...none,
      inputTokens: 250_000,
      outputTokens: 10_000,
      requests: 2,
      upstreamErrors: 1,
      deniedRequests: 1,
      budgetExhausted: true,
      modelSeconds: 1.75,
      costUsd: 0.6,
    });
  });

  it("skips a last line that a crash cut short", () => {
    expect(usageOfLog(`${log}{"kind":"forw`, prices)).toEqual(usageOfLog(log, prices));
  });

  it("adds the usage of two logs", () => {
    const one = usageOfLog(log, prices);

    expect(addUsage(one, one, prices)).toMatchObject({
      requests: 4,
      deniedRequests: 2,
      modelSeconds: 3.5,
      costUsd: 1.2,
    });
    expect(addUsage(noUsage, one, prices)).toEqual(one);
  });
});
