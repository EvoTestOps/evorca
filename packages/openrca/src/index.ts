/**
 * The `@evorca/openrca` entry, for an agent runner. It names the OpenRCA
 * scenarios, lists the candidate root causes of each, reads their tasks and
 * gives the difficulty of each, and writes predictions in OpenRCA's format.
 *
 * It exposes no scoring points, so an agent that imports it cannot read the
 * answers through it. Scoring has its own entry, `@evorca/openrca/scoring`.
 *
 * @module
 */
export { openRcaCandidates } from "./candidates.js";
export type { Candidates } from "./candidates.js";
export { formatPrediction, parsePrediction, writePredictions } from "./prediction.js";
export { openRcaScenarios } from "./scenarios.js";
export type { OpenRcaScenario } from "./scenarios.js";
export { difficultyOf, readTasks } from "./tasks.js";
export type { Difficulty, OpenRcaTask, TaskIndex } from "./tasks.js";
