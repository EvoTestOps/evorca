import { describe, expect, it } from "vitest";
import { parsePrediction } from "../../../packages/openrca/src/prediction.ts";
import { formatPrediction, readAnswer, submitAnswerTool } from "../src/answer.ts";
import type { Task } from "../src/task.ts";

const task: Task = {
  scenario: "telecom",
  row: 3,
  taskIndex: "task_7",
  instruction: "On April 11, 2020, between 00:00 and 00:30, two failures occurred.",
  candidates: { components: ["os_001", "docker_003"], reasons: ["CPU fault", "network delay"] },
};

const cause = (
  occurrence_datetime: string | null,
  component: string | null,
  reason: string | null,
) => ({ occurrence_datetime, component, reason });

describe("readAnswer", () => {
  it("accepts one root cause per failure with every field the task asks for", () => {
    const reading = readAnswer(
      {
        root_causes: [
          cause("2020-04-11 00:05:00", "docker_003", "CPU fault"),
          cause("2020-04-11 00:20:00", "os_001", "network delay"),
        ],
      },
      task,
    );
    expect(reading).toEqual({
      valid: true,
      causes: [
        { datetime: "2020-04-11 00:05:00", component: "docker_003", reason: "CPU fault" },
        { datetime: "2020-04-11 00:20:00", component: "os_001", reason: "network delay" },
      ],
    });
  });

  it.each([
    ["task_1", cause("2020-04-11 00:05:00", null, null)],
    ["task_2", cause(null, null, "CPU fault")],
    ["task_3", cause(null, "os_001", null)],
    ["task_4", cause("2020-04-11 00:05:00", null, "CPU fault")],
    ["task_5", cause("2020-04-11 00:05:00", "os_001", null)],
    ["task_6", cause(null, "os_001", "CPU fault")],
  ] as const)("accepts only the fields that %s asks for", (taskIndex, given) => {
    expect(readAnswer({ root_causes: [given] }, { ...task, taskIndex }).valid).toBe(true);
  });

  it("rejects an answer without a field that the task asks for, and keeps the rest", () => {
    const reading = readAnswer(
      { root_causes: [cause(null, "os_001", null)] },
      { ...task, taskIndex: "task_5" },
    );
    expect(reading).toEqual({
      valid: false,
      problems: ["Root cause 1 has no occurrence_datetime, which the issue asks for."],
      partial: [{ component: "os_001" }],
    });
  });

  it("rejects an invalid datetime, an unknown candidate, and an empty list", () => {
    const reading = readAnswer(
      {
        root_causes: [
          cause("2020-04-11T00:05:00Z", "docker_003", "disk full"),
          cause("2020-02-30 00:00:00", "os_001", "CPU fault"),
        ],
      },
      task,
    );
    expect(reading).toEqual({
      valid: false,
      problems: [
        'Root cause 1: occurrence_datetime "2020-04-11T00:05:00Z" is not a datetime in the format YYYY-MM-DD HH:MM:SS.',
        'Root cause 1: reason "disk full" is not one of the possible root cause reasons.',
        'Root cause 2: occurrence_datetime "2020-02-30 00:00:00" is not a datetime in the format YYYY-MM-DD HH:MM:SS.',
      ],
      partial: [{ component: "docker_003" }, { component: "os_001", reason: "CPU fault" }],
    });
    expect(readAnswer({ root_causes: [] }, task)).toEqual({
      valid: false,
      problems: ["root_causes must list at least one root cause."],
      partial: [],
    });
    expect(readAnswer("nonsense", task).valid).toBe(false);
  });

  it("accepts any non-empty component and reason without candidates", () => {
    const { candidates: _, ...blind } = task;
    const reading = readAnswer(
      { root_causes: [cause("2020-04-11 00:05:00", "node-7", "gremlins")] },
      blind,
    );
    expect(reading.valid).toBe(true);
    expect(readAnswer({ root_causes: [cause("2020-04-11 00:05:00", " ", "x")] }, blind).valid).toBe(
      false,
    );
  });
});

describe("formatPrediction", () => {
  it("writes OpenRCA prediction JSON that the runner parses back", () => {
    const causes = [
      { datetime: "2020-04-11 00:05:00", component: "docker_003", reason: "CPU fault" },
      { component: "os_001" },
    ];
    const json = formatPrediction(causes);
    expect(json).toBe(
      '{"1":{"root cause occurrence datetime":"2020-04-11 00:05:00","root cause component":"docker_003","root cause reason":"CPU fault"},"2":{"root cause component":"os_001"}}',
    );
    expect(parsePrediction(json)).toEqual([
      {
        occurredAt: Date.UTC(2020, 3, 10, 16, 5) / 1000,
        component: "docker_003",
        reason: "CPU fault",
      },
      { occurredAt: undefined, component: "os_001", reason: undefined },
    ]);
  });
});

describe("submitAnswerTool", () => {
  it("is strict, and limits the component and the reason to the candidates", () => {
    const tool = submitAnswerTool(task.candidates);
    expect(tool.strict).toBe(true);
    const item = JSON.stringify(tool.input_schema);
    expect(item).toContain('"enum":["os_001","docker_003"]');
    expect(item).toContain('"enum":["CPU fault","network delay"]');
    expect(JSON.stringify(submitAnswerTool(undefined).input_schema)).not.toContain("enum");
  });
});
