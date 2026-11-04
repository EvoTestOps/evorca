import { describe, expect, it } from "vitest";
import { isUnixSeconds, unixSeconds } from "./diagnosis.js";

describe("unixSeconds", () => {
  it("accepts a finite number", () => {
    expect(unixSeconds(1586534700)).toBe(1586534700);
    expect(isUnixSeconds(-0.5)).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity])("rejects %d", (value) => {
    expect(isUnixSeconds(value)).toBe(false);
    expect(() => unixSeconds(value)).toThrow(RangeError);
  });
});
