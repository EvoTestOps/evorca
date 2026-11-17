/**
 * The root cause components and reasons that an answer to each OpenRCA scenario
 * can name, as RCA-Agent's prompts list them. Whether an agent sees these lists
 * changes how hard the benchmark is, and RCA-Agent always sees them.
 *
 * `scripts/extract-candidates.ts` writes `candidates.json` from
 * `rca/baseline/rca_agent/prompt/basic_prompt_<System>.py` at OpenRCA commit
 * 2a481ae63cb045c3eadbeca9eddaa10ec1151979, the `openRcaCommit` in `pinned.ts`.
 *
 * @module
 */
import candidates from "./candidates.json" with { type: "json" };
import type { OpenRcaScenario } from "./scenarios.js";

/** The root cause components and reasons that an answer can name, in prompt order. */
export type Candidates = {
  readonly components: readonly string[];
  readonly reasons: readonly string[];
};

/**
 * The candidates of each scenario. Both Market scenarios have the candidates of
 * `basic_prompt_Market.py`.
 */
export const openRcaCandidates: Readonly<Record<OpenRcaScenario, Candidates>> = candidates;
