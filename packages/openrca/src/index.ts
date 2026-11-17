/**
 * The `@evorca/openrca` entry, for an agent runner. It names the OpenRCA
 * scenarios, reads their tasks, and writes predictions in OpenRCA's format.
 *
 * It exposes no scoring points, so an agent that imports it cannot read the
 * answers through it. Scoring has its own entry, `@evorca/openrca/scoring`.
 *
 * @module
 */
export { formatPrediction, parsePrediction, writePredictions } from "./prediction.js";
export { openRcaScenarios } from "./scenarios.js";
export type { OpenRcaScenario } from "./scenarios.js";
export { readTasks } from "./tasks.js";
export type { OpenRcaTask, TaskIndex } from "./tasks.js";
