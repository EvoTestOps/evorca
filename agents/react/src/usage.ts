/**
 * Token usage summed over a task's model responses, and its estimated cost.
 *
 * The cost uses the list prices per million tokens: base input, output, cache
 * reads, and five-minute cache writes, which cost 1.25 times base input. The
 * agent caches only with the five-minute TTL.
 *
 * @module
 */
import type Anthropic from "@anthropic-ai/sdk";

/** The token counts of one response, or of all responses of a task. */
export type Usage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
};

/** Prices in US dollars per million tokens. */
export type Prices = {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
};

/** The prices of each model that the agent can run, by model ID. */
export const prices: Readonly<Record<string, Prices>> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

/** Usage of no tokens. */
export const noUsage: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** Adds the usage of a response to `total`. */
export function addUsage(total: Usage, usage: Anthropic.Usage): Usage {
  return {
    input_tokens: total.input_tokens + usage.input_tokens,
    output_tokens: total.output_tokens + usage.output_tokens,
    cache_creation_input_tokens:
      total.cache_creation_input_tokens + (usage.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: total.cache_read_input_tokens + (usage.cache_read_input_tokens ?? 0),
  };
}

/** The cost of `usage` in US dollars. */
export function costUsd(usage: Usage, price: Prices): number {
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_creation_input_tokens * price.cacheWrite +
      usage.cache_read_input_tokens * price.cacheRead) /
    1_000_000
  );
}
