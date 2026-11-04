import { describe, expect, it } from "vitest";
import { summarize } from "./summary.js";

describe("summarize", () => {
  it("reports strict and partial accuracy per difficulty and in total", () => {
    expect(
      summarize([
        { row: 0, taskIndex: "task_1", score: 1 },
        { row: 1, taskIndex: "task_3", score: 0.5 },
        { row: 2, taskIndex: "task_4", score: 1 },
        { row: 3, taskIndex: "task_6", score: 0 },
        { row: 4, taskIndex: "task_7", score: 0.25 },
      ]),
    ).toEqual({
      easy: { tasks: 2, strict: 0.5, partial: 0.75 },
      middle: { tasks: 2, strict: 0.5, partial: 0.5 },
      hard: { tasks: 1, strict: 0, partial: 0.25 },
      total: { tasks: 5, strict: 0.4, partial: 0.55 },
    });
  });

  it("reports zero accuracy for a difficulty with no tasks", () => {
    expect(summarize([{ row: 0, taskIndex: "task_2", score: 1 }]).hard).toEqual({
      tasks: 0,
      strict: 0,
      partial: 0,
    });
  });
});
