import { describe, expect, it } from "vitest";
import { answer, readWindow, type Task } from "./random.ts";

const at = (datetime: string) => Date.parse(`${datetime.replace(" ", "T")}Z`);

describe("readWindow", () => {
  it.each([
    [
      "On March 4, 2021, between 19:30 and 20:00, two failures were recorded.",
      { start: at("2021-03-04 19:30:00"), end: at("2021-03-04 20:00:00"), failures: 2 },
    ],
    [
      "During the time range of March 6, 2021, from 23:30 to March 7, 2021, at 00:00, there was one failure.",
      { start: at("2021-03-06 23:30:00"), end: at("2021-03-07 00:00:00"), failures: 1 },
    ],
    [
      "A single failure was detected during the time range of April 11, 2020, from 02:30 to 03:00.",
      { start: at("2020-04-11 02:30:00"), end: at("2020-04-11 03:00:00"), failures: 1 },
    ],
    [
      "On April 11, 2020, between 02:00 and 02:30, a failure occurred in the system. The number of failures recorded within this time range is 1.",
      { start: at("2020-04-11 02:00:00"), end: at("2020-04-11 02:30:00"), failures: 1 },
    ],
    [
      "The cloud service system, cloudbed-1, experienced two failures within the time range of March 20, 2022, from 12:00 to 12:30.",
      { start: at("2022-03-20 12:00:00"), end: at("2022-03-20 12:30:00"), failures: 2 },
    ],
  ])("reads %j", (instruction, window) => {
    expect(readWindow(instruction)).toEqual(window);
  });

  it("throws on an instruction without a time window", () => {
    expect(() => readWindow("Find the root cause of two failures.")).toThrow();
  });
});

describe("answer", () => {
  const task: Task = {
    scenario: "bank",
    row: 11,
    instruction:
      "Within the time range of March 7, 2021, from 16:00 to 16:30, there were two failures detected in the system.",
    candidates: {
      components: ["Tomcat01", "Tomcat02", "Mysql01"],
      reasons: ["high CPU usage", "network latency"],
    },
  };
  const seeds = Array.from({ length: 600 }, (_, seed) => String(seed));

  it("gives the same answer for the same seed", () => {
    expect(answer(task, "42")).toEqual(answer({ ...task }, "42"));
  });

  it("gives other answers for other seeds and other rows", () => {
    const answers = new Set([
      JSON.stringify(answer(task, "42")),
      JSON.stringify(answer(task, "43")),
      JSON.stringify(answer({ ...task, row: 12 }, "42")),
    ]);
    expect(answers.size).toBe(3);
  });

  it("answers each failure with a minute in the window and a candidate", () => {
    const causes = seeds.flatMap((seed) => Object.entries(answer(task, seed)));

    expect(new Set(causes.map(([key]) => key))).toEqual(new Set(["1", "2"]));
    const minutes = new Set(causes.map(([, cause]) => cause["root cause occurrence datetime"]));
    const expected = Array.from(
      { length: 30 },
      (_, i) => `2021-03-07 16:${String(i).padStart(2, "0")}:00`,
    );
    expect(minutes).toEqual(new Set(expected));
    const components = new Set(causes.map(([, cause]) => cause["root cause component"]));
    expect(components).toEqual(new Set(task.candidates?.components));
    const reasons = new Set(causes.map(([, cause]) => cause["root cause reason"]));
    expect(reasons).toEqual(new Set(task.candidates?.reasons));
  });

  it("answers only the datetime without candidates", () => {
    const withoutCandidates = { ...task, candidates: undefined };

    expect(JSON.parse(JSON.stringify(Object.values(answer(withoutCandidates, "42"))))).toEqual([
      { "root cause occurrence datetime": expect.stringMatching(/^2021-03-07 16:[0-2]\d:00$/) },
      { "root cause occurrence datetime": expect.stringMatching(/^2021-03-07 16:[0-2]\d:00$/) },
    ]);
  });
});
