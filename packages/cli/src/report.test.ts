import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedInputs, type Summary } from "@evorca/openrca/scoring";
import { describe, expect, it, vi } from "vitest";
import { agents } from "./agents.js";
import { noUsage } from "./models.js";
import { reportRuns } from "./report.js";
import type { ModelSettings, RunRecord } from "./runs.js";

const { jobs: _, ...react } = agents.react;
const model: ModelSettings = {
  id: "claude-sonnet-5",
  effort: "high",
  taskBudgetUsd: 2,
  upstreamUrl: "https://api.anthropic.com",
  prices: {
    table: "anthropic-2026-11-17",
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    checkedAt: "2026-11-17",
    usdPerMTok: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  },
};
const session = {
  startedAt: "2026-11-18T05:00:00.000Z",
  git: { commit: "abc", dirty: false },
  versions: { node: "v26.13.1", docker: { client: "28.2.2", server: "28.2.2" } },
};

function run(runId: string, changes: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    benchmark: "openrca",
    scenario: "telecom",
    agent: { name: "react", ...react, image: "evorca-agent-react:abc", imageId: "sha256:1" },
    seed: 7,
    rows: null,
    model,
    budgetUsd: 50,
    jobs: 2,
    pinnedInputs,
    ...session,
    resumes: [],
    endedAt: "2026-11-18T06:10:00.000Z",
    tasks: [],
    abandoned: [],
    usage: { ...noUsage, requests: 10, costUsd: 1.5 },
    ...changes,
  };
}

function summary(strict: number, partial: number): Summary {
  return {
    easy: { tasks: 24, strict, partial },
    middle: { tasks: 18, strict, partial },
    hard: { tasks: 9, strict, partial },
    total: { tasks: 51, strict, partial },
  };
}

async function report(
  runs: readonly { record: RunRecord; scores?: Summary }[],
  runIds = runs.map(({ record }) => record.runId),
) {
  const runsDir = await mkdtemp(join(tmpdir(), "evorca-report-"));
  for (const { record, scores } of runs) {
    const dir = join(runsDir, record.scenario, record.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), JSON.stringify(record));
    if (scores !== undefined) {
      await writeFile(join(dir, "scores.json"), JSON.stringify({ summary: scores, scores: [] }));
    }
  }
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line = "") => void out.push(line));
  const error = vi.spyOn(console, "error").mockImplementation((line = "") => void err.push(line));
  try {
    const ok = await reportRuns({ runsDir, scenarios: ["telecom", "bank"], runIds });
    return { ok, out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

function tableRow(text: string, label: string): string[] | undefined {
  return text
    .split("\n")
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .find((cells) => cells[0] === label);
}

describe("reportRuns", () => {
  it("gives the mean, the sample standard deviation, the minimum, and the maximum of each accuracy", async () => {
    const { ok, out } = await report([
      { record: run("R-1"), scores: summary(0.1, 0.2) },
      { record: run("R-2", { seed: 8 }), scores: summary(0.2, 0.3) },
      { record: run("R-3", { seed: 9 }), scores: summary(0.6, 0.4) },
    ]);

    expect(ok).toBe(true);
    expect(out).toContain("telecom: 3 runs of react, claude-sonnet-5 at effort high");
    expect(tableRow(out, "total strict")).toEqual([
      "total strict",
      "51",
      "30.00",
      "26.46",
      "10.00",
      "60.00",
    ]);
    expect(tableRow(out, "hard partial")).toEqual([
      "hard partial",
      "9",
      "30.00",
      "10.00",
      "20.00",
      "40.00",
    ]);
  });

  it("gives each run's seed, accuracy, requests, cost, and wall time, and their mean and total", async () => {
    const { out } = await report([
      { record: run("R-1"), scores: summary(0.1, 0.2) },
      {
        record: run("R-2", {
          seed: 8,
          resumes: [session],
          endedAt: "2026-11-18T07:30:00.000Z",
          usage: { ...noUsage, requests: 20, costUsd: 2.25 },
        }),
        scores: summary(0.2, 0.3),
      },
      {
        record: run("R-3", { seed: 9, usage: { ...noUsage, requests: 30, costUsd: 0.25 } }),
        scores: summary(0.6, 0.4),
      },
    ]);

    expect(tableRow(out, "R-1")).toEqual(["R-1", "7", "10.00", "20.00", "10", "1.5000", "1:10:00"]);
    expect(tableRow(out, "R-2")).toEqual([
      "R-2",
      "8",
      "20.00",
      "30.00",
      "20",
      "2.2500",
      "2:30:00*",
    ]);
    expect(tableRow(out, "Mean")).toEqual(["Mean", "", "", "", "20.0", "1.3333", "1:36:40"]);
    expect(tableRow(out, "Total")).toEqual(["Total", "", "", "", "60", "4.0000", "4:50:00"]);
    expect(out).toContain("* Resumed");
  });

  it("leaves out each run that a resume would continue and names it", async () => {
    const exhausted = {
      row: 0,
      taskIndex: "task_1",
      outcome: "budget-exhausted",
      exitCode: null,
      seconds: 0,
      usage: noUsage,
    } as const;
    const { ok, out } = await report([
      { record: run("R-1"), scores: summary(0.1, 0.2) },
      { record: run("R-2", { endedAt: null }) },
      { record: run("R-3"), scores: summary(0.3, 0.4) },
      { record: run("R-4", { tasks: [exhausted] }), scores: summary(0, 0) },
    ]);

    expect(ok).toBe(true);
    expect(out).toContain("telecom: 2 runs of");
    expect(out).toContain("Left out, unfinished: R-2, R-4");
    expect(tableRow(out, "R-2")).toBeUndefined();
    expect(tableRow(out, "total strict")).toEqual([
      "total strict",
      "51",
      "20.00",
      "14.14",
      "10.00",
      "30.00",
    ]);
  });

  it("times a scenario from the end of the scenario that ran before it in the same run", async () => {
    const { out } = await report([
      {
        record: run("R-1", { scenario: "bank", endedAt: "2026-11-18T05:40:00.000Z" }),
        scores: summary(0.1, 0.2),
      },
      { record: run("R-1"), scores: summary(0.3, 0.4) },
    ]);
    const [telecom = "", bank = ""] = out.split("\nbank: ");

    expect(tableRow(telecom, "R-1")?.at(-1)).toBe("0:30:00");
    expect(tableRow(bank, "R-1")?.at(-1)).toBe("0:40:00");
  });

  it("names each run that does not cover a scenario", async () => {
    const { ok, out } = await report([
      { record: run("R-1"), scores: summary(0.1, 0.2) },
      { record: run("R-2"), scores: summary(0.3, 0.4) },
      { record: run("R-2", { scenario: "bank" }), scores: summary(0.5, 0.6) },
    ]);

    expect(ok).toBe(true);
    expect(out).toContain("bank: 1 run of");
    expect(out).toContain("Left out, without bank: R-1");
  });

  it("goes on to the next scenario after one with no finished run, and fails", async () => {
    const { ok, out, err } = await report([
      { record: run("R-1", { endedAt: null }) },
      { record: run("R-1", { scenario: "bank" }), scores: summary(0.5, 0.6) },
    ]);

    expect(ok).toBe(false);
    expect(err).toContain("telecom: no run is finished. R-1 can resume.");
    expect(out).toContain("bank: 1 run of");
  });

  it("gives no standard deviation for one run", async () => {
    const { out } = await report([{ record: run("R-1"), scores: summary(0.1, 0.2) }]);

    expect(tableRow(out, "total strict")).toEqual([
      "total strict",
      "51",
      "10.00",
      "-",
      "10.00",
      "10.00",
    ]);
  });

  it("refuses runs with other settings and names the field that differs", async () => {
    const { ok, err } = await report([
      { record: run("R-1"), scores: summary(0.1, 0.2) },
      { record: run("R-2", { model: { ...model, effort: "low" } }), scores: summary(0.2, 0.3) },
    ]);

    expect(ok).toBe(false);
    expect(err).toContain("Run R-2 has other settings than run R-1");
    expect(err).toContain('model.effort: the run has "low", not "high"');
  });

  it("refuses a run that does not exist", async () => {
    const { ok, err } = await report(
      [{ record: run("R-1"), scores: summary(0.1, 0.2) }],
      ["R-1", "R-9"],
    );

    expect(ok).toBe(false);
    expect(err).toContain("No run R-9");
  });
});
