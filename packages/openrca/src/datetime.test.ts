import type { UnixSeconds } from "@evorca/core";
import { describe, expect, it } from "vitest";
import { fromOpenRcaDatetime, toOpenRcaDatetime } from "./datetime.js";

describe("OpenRCA datetimes", () => {
  it("are wall-clock times at UTC+8", () => {
    expect(toOpenRcaDatetime(1586534700 as UnixSeconds)).toBe("2020-04-11 00:05:00");
    expect(fromOpenRcaDatetime("2020-04-11 00:05:00")).toBe(1586534700);
  });

  it("reject text that is not a valid datetime", () => {
    expect(() => fromOpenRcaDatetime("2020-02-30 00:00:00")).toThrow(RangeError);
  });
});
