/**
 * The models that an agent can call through the model proxy, their prices, and
 * the usage and cost of a task's requests. A task's usage is a fold over the
 * entries of its `requests.jsonl`, so the proxy and a resumed run count it the
 * same way.
 *
 * @module
 */

/** The price of each kind of token in US dollars per million tokens. */
export type Prices = {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
};

/** An `output_config.effort` of the Messages API. */
export type Effort = (typeof efforts)[number];

/** The efforts that `--effort` accepts. */
export const efforts = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Where the prices in `models` come from, and the day they were read. Its `id`
 * changes whenever a price changes.
 */
export const priceTable = {
  id: "anthropic-2026-11-17",
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  checkedAt: "2026-11-17",
} as const;

/**
 * The models by API ID, each with its prices and the effort that a request
 * without `output_config.effort` gets.
 */
export const models = {
  "claude-sonnet-5": {
    defaultEffort: "high",
    usdPerMTok: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  },
} as const satisfies Record<string, { defaultEffort: Effort; usdPerMTok: Prices }>;

/** The API ID of a model in `models`, such as `claude-sonnet-5`. */
export type ModelId = keyof typeof models;

/**
 * The tokens of one or more requests by kind. Cache writes split by the
 * lifetime of the cache entry, because a one-hour entry costs more.
 */
export type Tokens = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreation5mInputTokens: number;
  readonly cacheCreation1hInputTokens: number;
  readonly cacheReadInputTokens: number;
};

/**
 * The model usage of a task or a run. `requests` counts the requests that the
 * proxy forwarded, and `upstreamErrors` the forwarded requests that did not
 * succeed. `deniedRequests` counts the requests that the proxy refused, and
 * `budgetExhausted` says whether one of them was for a spent budget.
 * `modelSeconds` adds up the time that forwarded requests took.
 */
export type ModelUsage = Tokens & {
  readonly requests: number;
  readonly upstreamErrors: number;
  readonly deniedRequests: number;
  readonly budgetExhausted: boolean;
  readonly modelSeconds: number;
  readonly costUsd: number;
};

/** The error type of the proxy's response to a request that a spent budget forbids. */
export const budgetExhaustedError = "evorca_budget_exhausted";

/**
 * One line of a task's `requests.jsonl`: a request that the proxy denied with
 * an error type, or one that it forwarded, with the upstream status, its
 * request ID, its error type, and its tokens when it succeeded.
 */
export type RequestEntry =
  | {
      readonly kind: "denied";
      readonly at: string;
      readonly status: number;
      readonly error: string;
    }
  | {
      readonly kind: "forwarded";
      readonly at: string;
      readonly status: number;
      readonly seconds: number;
      readonly requestId: string | null;
      readonly error: string | null;
      readonly tokens: Tokens | null;
      readonly costUsd: number;
    };

const noTokens: Tokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** The usage of no requests. */
export const noUsage: ModelUsage = {
  ...noTokens,
  requests: 0,
  upstreamErrors: 0,
  deniedRequests: 0,
  budgetExhausted: false,
  modelSeconds: 0,
  costUsd: 0,
};

/** Returns the cost of `tokens` in US dollars at `prices`, to the billionth of a dollar. */
export function costUsd(tokens: Tokens, prices: Prices): number {
  const microDollars =
    tokens.inputTokens * prices.input +
    tokens.outputTokens * prices.output +
    tokens.cacheCreation5mInputTokens * prices.cacheWrite5m +
    tokens.cacheCreation1hInputTokens * prices.cacheWrite1h +
    tokens.cacheReadInputTokens * prices.cacheRead;
  return Math.round(microDollars * 1000) / 1e9;
}

/**
 * Reads the tokens from the `usage` of a Messages API response. The cache
 * writes that `usage.cache_creation` does not count as one-hour writes are
 * five-minute writes. It returns undefined if `usage` lacks the input or the
 * output tokens.
 */
export function tokensOf(usage: unknown): Tokens | undefined {
  if (!isRecord(usage)) return undefined;
  const { input_tokens: input, output_tokens: output } = usage;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const written = count(usage.cache_creation_input_tokens);
  const oneHour = isRecord(usage.cache_creation)
    ? Math.min(count(usage.cache_creation.ephemeral_1h_input_tokens), written)
    : 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreation5mInputTokens: written - oneHour,
    cacheCreation1hInputTokens: oneHour,
    cacheReadInputTokens: count(usage.cache_read_input_tokens),
  };
}

/** Returns `usage` after one more request, with its cost at `prices`. */
export function addEntry(usage: ModelUsage, entry: RequestEntry, prices: Prices): ModelUsage {
  if (entry.kind === "denied") {
    return {
      ...usage,
      deniedRequests: usage.deniedRequests + 1,
      budgetExhausted: usage.budgetExhausted || entry.error === budgetExhaustedError,
    };
  }
  const tokens = addTokens(usage, entry.tokens ?? noTokens);
  return {
    ...usage,
    ...tokens,
    requests: usage.requests + 1,
    upstreamErrors: usage.upstreamErrors + (entry.error === null ? 0 : 1),
    modelSeconds: milli(usage.modelSeconds + entry.seconds),
    costUsd: costUsd(tokens, prices),
  };
}

/** Returns the usage of two sets of requests together, with their cost at `prices`. */
export function addUsage(a: ModelUsage, b: ModelUsage, prices: Prices): ModelUsage {
  const tokens = addTokens(a, b);
  return {
    ...tokens,
    requests: a.requests + b.requests,
    upstreamErrors: a.upstreamErrors + b.upstreamErrors,
    deniedRequests: a.deniedRequests + b.deniedRequests,
    budgetExhausted: a.budgetExhausted || b.budgetExhausted,
    modelSeconds: milli(a.modelSeconds + b.modelSeconds),
    costUsd: costUsd(tokens, prices),
  };
}

/**
 * Returns the usage of the entries in the text of a `requests.jsonl`. It skips
 * a last line that a crash cut short.
 */
export function usageOfLog(text: string, prices: Prices): ModelUsage {
  const entries = text.split("\n").flatMap((line): RequestEntry[] => {
    try {
      return line === "" ? [] : [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  return entries.reduce((usage, entry) => addEntry(usage, entry, prices), noUsage);
}

function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreation5mInputTokens: a.cacheCreation5mInputTokens + b.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: a.cacheCreation1hInputTokens + b.cacheCreation1hInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function milli(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** Whether `value` is a JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
