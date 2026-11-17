/**
 * The `@evorca/openrca/dataset` entry, for a tool that downloads OpenRCA's
 * answer keys and telemetry, such as `evorca fetch`.
 *
 * @module
 */
export { answerKeyFiles } from "../pinned.js";
export { fetchOpenRcaData } from "./fetch.js";
export type { FileProgress } from "./fetch.js";
