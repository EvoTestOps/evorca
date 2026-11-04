/**
 * The `@evorca/core` entry. It exports the domain types that every other
 * evorca package shares, and the functions that create a `UnixSeconds`.
 *
 * @module
 */
export { isUnixSeconds, unixSeconds } from "./diagnosis.js";
export type { Diagnosis, RootCause, UnixSeconds } from "./diagnosis.js";
