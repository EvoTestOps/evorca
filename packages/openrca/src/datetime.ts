/**
 * Converts between OpenRCA datetime strings and Unix seconds.
 *
 * OpenRCA writes datetimes as `YYYY-MM-DD HH:MM:SS` in UTC+8. Every published
 * `record.csv` pairs its timestamps with datetimes eight hours ahead, so one
 * fixed offset serves all four systems.
 *
 * @module
 */
import type { UnixSeconds } from "@evorca/core";

const utcOffsetSeconds = 8 * 60 * 60;

/**
 * Formats a time as an OpenRCA datetime.
 *
 * @param t - The time.
 * @returns The datetime at UTC+8 to the whole second, such as `2020-04-11 00:05:00`.
 * @throws RangeError if `t` is NaN or outside the range of `Date`.
 */
export function toOpenRcaDatetime(t: UnixSeconds): string {
  return new Date((t + utcOffsetSeconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Parses an OpenRCA datetime.
 *
 * @param s - A datetime such as `2020-04-11 00:05:00`, read as UTC+8.
 * @returns The time that `s` names.
 * @throws RangeError if `s` is not in the form `YYYY-MM-DD HH:MM:SS` or names a
 *   time that does not exist, such as `2020-02-30 00:00:00`.
 */
export function fromOpenRcaDatetime(s: string): UnixSeconds {
  const t = parseOpenRcaDatetime(s);
  if (t === undefined) throw new RangeError(`Not an OpenRCA datetime: ${s}`);
  return t;
}

/**
 * Parses an OpenRCA datetime like {@link fromOpenRcaDatetime}, but returns
 * `undefined` where that function throws.
 */
export function parseOpenRcaDatetime(s: string): UnixSeconds | undefined {
  const t = (Date.parse(`${s.replace(" ", "T")}Z`) / 1000 - utcOffsetSeconds) as UnixSeconds;
  return Number.isInteger(t) && toOpenRcaDatetime(t) === s ? t : undefined;
}
