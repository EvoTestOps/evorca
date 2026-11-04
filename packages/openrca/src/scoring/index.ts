/**
 * The `@evorca/openrca/scoring` entry, for a scorer. It runs the official
 * OpenRCA evaluator and summarizes its scores.
 *
 * An agent runner imports `@evorca/openrca` instead, which exposes no scoring
 * points.
 *
 * @module
 */
export { scoreWithOfficialEvaluator } from "./evaluator.js";
export type { ScoredRow } from "./evaluator.js";
export { summarize } from "./summary.js";
export type { Accuracy, Difficulty, Summary } from "./summary.js";
