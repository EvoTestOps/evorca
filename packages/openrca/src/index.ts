/**
 * The `@evorca/openrca` entry, for an agent runner. It reads OpenRCA tasks and
 * writes predictions in OpenRCA's format.
 *
 * It exposes no scoring points, so an agent that imports it cannot read the
 * answers through it. Scoring has its own entry, `@evorca/openrca/scoring`.
 *
 * @module
 */
export { fromOpenRcaDatetime, toOpenRcaDatetime } from "./datetime.js";
export { formatPrediction, parsePrediction, writePredictions } from "./prediction.js";
export { openRcaSystems, readTasks } from "./tasks.js";
export type { OpenRcaSystem, OpenRcaTask, TaskIndex } from "./tasks.js";
