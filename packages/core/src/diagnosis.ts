/**
 * The root causes that an investigation reports.
 *
 * These types belong to no benchmark. A benchmark package such as
 * `@evorca/openrca` converts them to and from the benchmark's own format.
 *
 * @module
 */

/**
 * Seconds since the Unix epoch, 1970-01-01 00:00:00 UTC.
 *
 * A plain `number` does not type-check as `UnixSeconds`, so a value in
 * milliseconds cannot pass for one. Cast to `UnixSeconds` only where the unit
 * is known, such as in a parser.
 */
export type UnixSeconds = number & { readonly __brand: "UnixSeconds" };

/**
 * One root cause of an incident. Every field is optional, because a task can
 * ask for any subset of them.
 */
export type RootCause = {
  /** When the root cause occurred. */
  readonly occurredAt?: UnixSeconds;
  /** The component where the root cause occurred, as the system names it. */
  readonly component?: string;
  /** What went wrong, such as `high memory usage`. */
  readonly reason?: string;
};

/** The root causes that an investigation reports for one incident. An empty array reports none. */
export type Diagnosis = readonly RootCause[];
