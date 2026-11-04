/**
 * The root causes that an investigation reports.
 *
 * These types belong to no benchmark. A benchmark package such as
 * `@evorca/openrca` converts them to and from the benchmark's own format.
 *
 * @module
 */

/**
 * Seconds since the Unix epoch, 1970-01-01 00:00:00 UTC. The brand stops a plain
 * `number`, such as a time in milliseconds, from passing for one. Create one with
 * {@link unixSeconds} or {@link isUnixSeconds}, never with a cast.
 */
export type UnixSeconds = number & { readonly __brand: "UnixSeconds" };

/** Returns whether `value` is finite, and so valid as {@link UnixSeconds}. */
export function isUnixSeconds(value: number): value is UnixSeconds {
  return Number.isFinite(value);
}

/**
 * Returns `value` as {@link UnixSeconds}.
 *
 * @throws RangeError if `value` is NaN or infinite.
 */
export function unixSeconds(value: number): UnixSeconds {
  if (!isUnixSeconds(value)) throw new RangeError(`Not a time in Unix seconds: ${value}`);
  return value;
}

/**
 * One root cause of an incident. A task can ask for any subset of the fields,
 * so each is optional. `component` is the name that the system uses, and
 * `reason` says what went wrong, such as `high memory usage`.
 */
export type RootCause = {
  readonly occurredAt?: UnixSeconds;
  readonly component?: string;
  readonly reason?: string;
};

/** The root causes that an investigation reports for one incident. An empty array reports none. */
export type Diagnosis = readonly RootCause[];
