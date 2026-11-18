import { describe, expect, it } from "vitest";
import { openRcaCandidates } from "../../../packages/openrca/src/candidates.ts";
import json from "../background.json" with { type: "json" };
import { buildPrompt, type Background, type Limits } from "../src/prompt.ts";
import type { Task } from "../src/task.ts";

const background: Background = json;
const limits: Limits = { maxSteps: 50, commandTimeoutSeconds: 120, outputChars: 16_000 };
const candidates: Readonly<Record<string, Task["candidates"]>> = openRcaCandidates;

const task: Task = {
  scenario: "telecom",
  row: 0,
  taskIndex: "task_7",
  instruction: "On April 11, 2020, between 00:00 and 00:30, a failure occurred.",
  candidates: openRcaCandidates.telecom,
};

describe("background.json", () => {
  it("has the candidates of candidates.json for every scenario", () => {
    expect(Object.keys(background.scenarios)).toEqual(Object.keys(openRcaCandidates));
    for (const [scenario, { candidates: listed }] of Object.entries(background.scenarios)) {
      expect(listed).toEqual(candidates[scenario]);
    }
  });

  it("points every schema at /data/ and keeps one candidates placeholder", () => {
    for (const { schema } of Object.values(background.scenarios)) {
      expect(schema).toContain("`/data/");
      expect(schema).not.toContain("dataset/");
      expect(schema.split("{cand}")).toHaveLength(2);
    }
    expect(background.scenarios["market-cloudbed-2"]?.schema).toContain(
      "You can access the telemetry directory of `cloudbed-2` in our microservices system: `/data/`.",
    );
  });

  it("keeps no rule that forbids writing code, files, or bash", () => {
    expect(background.rules).not.toContain("DO NOT include any programming language");
    expect(background.rules).not.toContain("DO NOT save anything in the local file system");
    expect(background.rules).not.toContain("Executor");
    expect(background.rules).toContain("pytz.timezone('Asia/Shanghai')");
  });
});

describe("buildPrompt", () => {
  it("lists RCA-Agent's candidates as RCA-Agent's prompt does", () => {
    const { system } = buildPrompt(task, background, limits);
    expect(system).toContain(background.scenarios.telecom?.cand);
    expect(system).toContain(
      "(if the root cause is at the node level, i.e., the root cause is a specific node)",
    );
    expect(system).toContain(
      "Select each root cause component and reason from the possible root cause",
    );
    expect(system).not.toContain("{cand}");
  });

  it("lists other candidates as they are, and none without candidates", () => {
    const other = buildPrompt(
      { ...task, candidates: { components: ["os_001", "os_002"], reasons: ["CPU fault"] } },
      background,
      limits,
    );
    expect(other.system).toContain(
      "## POSSIBLE ROOT CAUSE COMPONENTS:\n\n- os_001\n- os_002\n\n## POSSIBLE ROOT CAUSE REASONS:\n\n- CPU fault",
    );
    const { candidates: _, ...blind } = task;
    const none = buildPrompt(blind, background, limits);
    expect(none.system).not.toContain("POSSIBLE ROOT CAUSE");
    expect(none.system).not.toContain("{cand}");
    expect(none.system).not.toContain("Select each root cause component");
  });

  it("gives every task of a scenario the same system prompt and tools", () => {
    const first = buildPrompt(task, background, limits);
    const second = buildPrompt(
      { ...task, row: 9, taskIndex: "task_2", instruction: "Another issue." },
      background,
      limits,
    );
    expect(second.system).toBe(first.system);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.sha256).toBe(first.sha256);
    expect(second.instruction).not.toBe(first.instruction);
    expect(first.instruction).toBe(
      `The issue you are going to solve is:\n\n${task.instruction}\n\nSolve the issue step-by-step.`,
    );
  });

  it("states the limits and declares the bash tool by its type", () => {
    const { system, tools } = buildPrompt(task, background, { ...limits, maxSteps: 7 });
    expect(system).toContain("You can make at most 7 tool calls.");
    expect(system).toContain("longer than 120 seconds");
    expect(system).toContain("longer than 16000 characters");
    expect(tools[0]).toEqual({ type: "bash_20250124", name: "bash" });
  });

  it("throws for a scenario without a background", () => {
    expect(() => buildPrompt({ ...task, scenario: "nowhere" }, background, limits)).toThrow();
  });
});
