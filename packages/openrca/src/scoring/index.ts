/**
 * The `@evorca/openrca/scoring` entry, for a scorer. It runs the official
 * OpenRCA evaluator, summarizes its scores, and reproduces the scores in
 * OpenRCA's archive of RCA-Agent predictions.
 *
 * An agent runner imports `@evorca/openrca` instead, which exposes no scoring
 * points.
 *
 * @module
 */
export { pinnedInputs } from "../pinned.js";
export { reproduceArchive } from "./archive.js";
export type { Mismatch, Stage } from "./archive.js";
export { evaluatorVersions, scoreWithOfficialEvaluator } from "./evaluator.js";
export type { ScoredRow } from "./evaluator.js";
export { summarize } from "./summary.js";
export type { Accuracy, Difficulty, Summary } from "./summary.js";
