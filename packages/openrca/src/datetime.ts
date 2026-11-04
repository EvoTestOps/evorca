/**
 * Converts between OpenRCA datetime strings and Unix seconds.
 *
 * OpenRCA writes datetimes as `YYYY-MM-DD HH:MM:SS` in UTC+8. Every published
 * `record.csv` pairs its timestamps with datetimes eight hours ahead, so one
 * fixed offset serves all four systems.
 *
 * @module
 */
import { isUnixSeconds, type UnixSeconds } from "@evorca/core";

const utcOffsetSeconds = 8 * 60 * 60;

/**
 * Formats `t` as an OpenRCA datetime to the whole second, such as
 * `2020-04-11 00:05:00`.
 *
 * @throws RangeError if `t` is outside the range of `Date`.
 */
export function toOpenRcaDatetime(t: UnixSeconds): string {
  return new Date((t + utcOffsetSeconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Parses an OpenRCA datetime such as `2020-04-11 00:05:00`. Returns undefined
 * unless `s` has the form `YYYY-MM-DD HH:MM:SS` and names a time that exists,
 * so `2020-02-30 00:00:00` gives undefined.
 */
export function parseOpenRcaDatetime(s: string): UnixSeconds | undefined {
  const t = Date.parse(`${s.replace(" ", "T")}Z`) / 1000 - utcOffsetSeconds;
  return isUnixSeconds(t) && toOpenRcaDatetime(t) === s ? t : undefined;
}
