import type { Diagnosis, UnixSeconds } from "@evorca/core";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { formatPrediction, parsePrediction, writePredictions } from "./prediction.js";

describe("predictions", () => {
  const diagnosis: Diagnosis = [
    { occurredAt: 1586534700 as UnixSeconds, component: "docker_003" },
    { reason: "CPU fault" },
  ];

  it("number causes from 1 and omit absent fields", () => {
    expect(formatPrediction(diagnosis)).toBe(
      '{"1":{"root cause occurrence datetime":"2020-04-11 00:05:00","root cause component":"docker_003"},"2":{"root cause reason":"CPU fault"}}',
    );
  });

  it("round-trip through parsePrediction", () => {
    expect(parsePrediction(formatPrediction(diagnosis))).toEqual(diagnosis);
  });

  it.each([
    "the root cause is docker_003",
    '{"1": {"root cause component": "docker_003"',
    '[{"root cause component": "docker_003"}]',
    '{"1": {"root cause component": 3}}',
    '{"1": {"root cause component": "docker_003", "confidence": "high"}}',
  ])("parse malformed text %j as no causes", (raw) => {
    expect(parsePrediction(raw)).toEqual([]);
  });

  it("keep a cause with an invalid datetime, without its datetime", () => {
    expect(
      parsePrediction(
        '{"1": {"root cause occurrence datetime": "2020-04-11 00:05", "root cause component": "docker_003"}}',
      ),
    ).toEqual([{ component: "docker_003" }]);
  });

  it("are written one row per task in order, empty where no diagnosis exists", () => {
    const csv = writePredictions(
      3,
      new Map([
        [2, [{ component: "db_007" }]],
        [0, [{ reason: "CPU fault" }]],
      ]),
    );
    const rows = parse<{ prediction: string }>(csv, { columns: true });

    expect(rows.map((row) => parsePrediction(row.prediction))).toEqual([
      [{ reason: "CPU fault" }],
      [],
      [{ component: "db_007" }],
    ]);
  });
});
