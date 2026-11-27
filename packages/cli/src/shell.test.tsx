import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RGBA } from "@opentui/core";
import { ManualClock, type TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { palette } from "./parts.js";
import { parseRows } from "./runs.js";
import { Shell, type Bench } from "./shell.js";

const wordmark = [
  "#####.#...#..###..####...###...###.",
  "#.....#...#.#...#.#...#.#...#.#...#",
  "#.....#...#.#...#.#...#.#.....#...#",
  "####..#...#.#...#.####..#.....#####",
  "#.....#...#.#...#.#.#...#.....#...#",
  "#......#.#..#...#.#..#..#...#.#...#",
  "#####...#....###..#...#..###..#...#",
];
const dark = wordmark.map((row) => row.replaceAll("#", "."));
const lit = wordmark.join("").split("#").length - 1;
const firstExample = "Why did checkout p99 latency spike at 14:05?";
const secondExample = "Find the root cause of the 5xx burst on payments";

let setup: TestRendererSetup;
let clock: ManualClock;
let onExit: (lines?: readonly string[], code?: number) => void;
let wallTime: Date;
let bench: Bench = {
  dataDir: "/no/data",
  runsDir: "/no/runs",
  evaluate: () => Promise.resolve(true),
};

async function open(width = 100, height = 30, directory = "~/incidents") {
  clock = new ManualClock();
  onExit = vi.fn();
  wallTime = new Date(2026, 10, 17, 14, 5, 12);
  setup = await testRender(
    <Shell directory={directory} wallTime={() => wallTime} bench={bench} onExit={onExit} />,
    { width, height, clock, exitOnCtrlC: false },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

async function at(ms: number) {
  await act(async () => clock.setTime(ms));
  await setup.renderOnce();
  return setup.captureCharFrame();
}

async function type(text: string) {
  await act(async () => setup.mockInput.typeText(text));
  await setup.renderOnce();
  return setup.captureCharFrame();
}

async function enter(line: string) {
  await act(async () => {
    await setup.mockInput.typeText(line);
    setup.mockInput.pressEnter();
  });
  await setup.renderOnce();
  return setup.captureCharFrame();
}

function placeholder(frame: string) {
  return /› (.*?) *\n/.exec(frame)?.[1] ?? "";
}

function nonGrays() {
  return setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .flatMap((span) =>
      [span.fg, span.bg].map((color) => ({ text: span.text, rgb: color.toInts() })),
    )
    .filter(({ rgb: [r, g, b] }) => r !== g || g !== b);
}

const states = new Map<string, string>([
  [palette.bright, "#"],
  [palette.muted, "-"],
  [palette.border, "."],
]);

function leds() {
  return setup
    .captureSpans()
    .lines.map((line) =>
      line.spans
        .flatMap((span) =>
          [...span.text].filter((char) => char === "•").map(() => states.get(hex(span.fg)) ?? "?"),
        )
        .join(""),
    )
    .filter((row) => row.length > 0);
}

function hex(color: RGBA) {
  return `#${color
    .toInts()
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function count(rows: readonly string[], state: string) {
  return rows.join("").split(state).length - 1;
}

function strays(rows: readonly string[]) {
  return rows.flatMap((row, y) =>
    [...row].filter((state, x) => state !== "." && wordmark[y]?.[x] !== "#"),
  ).length;
}

describe("palette", () => {
  it("holds only grays", () => {
    for (const [name, hex] of Object.entries(palette)) {
      const [r, g, b] = RGBA.fromHex(hex).toInts();
      expect([g, b], name).toEqual([r, r]);
    }
  });
});

describe("Shell", () => {
  afterEach(() => act(() => setup.dispose()));

  it("draws only grays, at every stage of the animations and in the session", async () => {
    await open();
    let dimmed = 0;
    for (let ms = 0; ms <= 12_000; ms += 50) {
      await at(ms);
      dimmed += count(leds(), "-");
      expect(nonGrays(), `${ms} ms`).toEqual([]);
    }
    expect(dimmed).toBeGreaterThan(0);

    await enter("hello");
    await type("draft");

    expect(nonGrays()).toEqual([]);
  });

  it("shows the wordmark, the tagline, the input, the hints, and the footer at home", async () => {
    await open();
    const frame = await at(1000);

    expect(leds()).toEqual(wordmark);
    expect(frame).toContain("autonomous incident investigation");
    expect(frame).toMatch(/^ +› /m);
    expect(frame).toContain("enter send   /help commands   ctrl+c exit");
    expect(frame).toMatch(new RegExp(`~/incidents +evorca v${packageJson.version}`));
  });

  it("draws the input as a prompt over a rule, without a box", async () => {
    await open();
    const home = await at(1000);
    await enter("hello");
    const session = await type("draft");

    for (const frame of [home, session]) {
      expect(frame).toMatch(/^( +)› .*\n\1─{40,} *\n\1enter send/m);
      expect(frame).not.toMatch(/[╭╮╰╯│]/);
    }
  });

  it("switches the dots of the wordmark on one at a time as it boots", async () => {
    await open();
    expect(leds()).toEqual(dark);

    await at(100);
    const early = leds();
    await at(400);
    const later = leds();
    await at(1000);

    expect(count(early, "#")).toBeGreaterThan(0);
    expect(count(early, "#")).toBeLessThan(count(later, "#"));
    expect(count(later, "#")).toBeLessThan(lit);
    expect(strays(early) + strays(later)).toBe(0);
    expect(leds()).toEqual(wordmark);
  });

  it("dims a few dots of the wordmark for a moment every few seconds", async () => {
    await open();
    const step = 25;
    const flickers: { start: number; end: number }[] = [];
    for (let ms = 1000; ms <= 20_000; ms += step) {
      await at(ms);
      const rows = leds();
      const dimmed = count(rows, "-");
      expect(
        rows.map((row) => row.replaceAll("-", "#")),
        `${ms} ms`,
      ).toEqual(wordmark);
      expect(dimmed, `${ms} ms`).toBeLessThanOrEqual(4);
      if (dimmed === 0) continue;
      const last = flickers.at(-1);
      if (last && last.end === ms - step) last.end = ms;
      else flickers.push({ start: ms, end: ms });
    }

    expect(flickers[0]?.start).toBeGreaterThan(2000);
    expect(flickers.length).toBeGreaterThanOrEqual(2);
    expect(flickers.length).toBeLessThanOrEqual(6);
    for (const { start, end } of flickers) expect(end - start).toBeLessThan(300);
    for (const [index, { start }] of flickers.slice(1).entries()) {
      expect(start - (flickers[index]?.start ?? 0)).toBeGreaterThan(2000);
    }
  });

  it("shows the plain name instead of the wordmark when the terminal is too narrow", async () => {
    await open(73, 30);
    expect(leds()).toEqual(dark);
    await act(() => setup.dispose());

    await open(72, 30);
    const frame = await at(1000);

    expect(frame).not.toContain("•");
    expect(frame).toMatch(/^ +evorca +$/m);
  });

  it("shortens the directory to its last folders when the footer is narrow", async () => {
    await open(40, 30, "~/Documents/doctoral-research/evorca");
    const frame = await at(1000);

    expect(frame).toMatch(new RegExp(`^ +…/evorca +evorca v${packageJson.version} +$`, "m"));
  });

  it("types out example questions while the input is empty", async () => {
    await open();
    const midway = placeholder(await at(1200));
    const typed = placeholder(await at(3000));
    const next = placeholder(await at(7000));

    expect(midway.length).toBeGreaterThan(0);
    expect(firstExample.startsWith(midway)).toBe(true);
    expect(midway).not.toBe(firstExample);
    expect(typed).toBe(firstExample);
    expect(next).toBe(secondExample);
  });

  it("moves to the session view on the first line and answers it", async () => {
    await open();
    await at(1000);
    const frame = await enter("hello");

    expect(frame).not.toContain("•");
    expect(frame).not.toContain("autonomous incident investigation");
    expect(frame).toMatch(
      /^ +14:05:12 +you +hello +\n +14:05:12 +evorca +No agent is connected yet\. +$/m,
    );
    expect(frame).toMatch(/^ +› +\n/m);
    expect(frame).toContain("enter send   /help commands   ctrl+c exit");
    expect(frame).toMatch(new RegExp(`~/incidents +evorca v${packageJson.version}`));
  });

  it("stamps each entry with the local time when it was added", async () => {
    await open();
    await enter("hello");
    wallTime = new Date(2026, 10, 17, 9, 3, 7);
    const frame = await enter("/help");

    expect(frame).toMatch(/^ +14:05:12 +you +hello +$/m);
    expect(frame).toMatch(/^ +09:03:07 +you +\/help +$/m);
    expect(frame).toMatch(/^ +09:03:07 +evorca +\/help +List the commands +$/m);
  });

  it("stays home on a blank line", async () => {
    await open();
    await at(1000);
    const frame = await enter("   ");

    expect(leds()).toEqual(wordmark);
    expect(frame).not.toMatch(/ you /);
  });

  it("lists the commands for /help, each line under the first", async () => {
    await open(120);
    const lines = (await enter("/help")).split("\n");
    const first = lines.findIndex((line) => / \/help +List the commands/.test(line));
    const commands = lines.slice(first, first + 3);
    const columns = (pattern: RegExp) => commands.map((line) => line.search(pattern));

    expect(commands[1]).toMatch(/ \/benchmark +Pick scenarios, tasks, and an agent, and run them/);
    expect(commands[2]).toMatch(/ \/exit +Exit evorca/);
    expect(new Set(columns(/\/\w/)).size).toBe(1);
    expect(new Set(columns(/(List|Pick|Exit) /)).size).toBe(1);
  });

  it("names an unknown command", async () => {
    await open();
    const frame = await enter("/nope");

    expect(frame).toContain("Unknown command /nope. Type /help for commands.");
  });

  it("keeps the newest entry in view", async () => {
    await open();
    const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
    for (const word of words) await enter(word);
    const frame = setup.captureCharFrame();

    expect(frame).not.toMatch(/ you +one /);
    expect(frame).toMatch(/ you +ten /);
  });

  it("schedules no work while nothing moves", async () => {
    await open();
    await at(3000);
    expect(clock.pendingTimerCount).toBeGreaterThan(0);

    await enter("hello");
    const typed = await type("draft");

    expect(clock.pendingTimerCount).toBe(0);
    expect(await at(20_000)).toBe(typed);
  });

  it("exits once on /exit", async () => {
    await open();
    await enter("/exit");

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("exits once on ctrl+c", async () => {
    await open();
    await act(async () => setup.mockInput.pressCtrlC());

    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe("/benchmark", () => {
  const answerKey = "ANSWER-KEY";
  const frames: string[] = [];
  let finish: (ok: boolean) => void;
  let request: Parameters<Bench["evaluate"]>[0] | undefined;

  afterEach(() => {
    expect(frames.join("\n")).not.toContain(answerKey);
    frames.length = 0;
    request = undefined;
    return act(() => setup.dispose());
  });

  async function openWithData(width = 120, height = 30, bankTasks = ["task_2", "task_6"]) {
    const root = await mkdtemp(join(tmpdir(), "evorca-shell-"));
    const query = (indices: readonly string[]) =>
      [
        "task_index,instruction,scoring_points",
        ...indices.map(
          (index, row) => `${index},Find the cause of failure ${row}.,${answerKey} ${row}`,
        ),
      ].join("\n");
    await mkdir(join(root, "data", "telecom", "telemetry"), { recursive: true });
    await mkdir(join(root, "data", "bank"), { recursive: true });
    await writeFile(
      join(root, "data", "telecom", "query.csv"),
      query(["task_1", "task_4", "task_7"]),
    );
    await writeFile(join(root, "data", "bank", "query.csv"), query(bankTasks));
    bench = {
      dataDir: join(root, "data"),
      runsDir: join(root, "runs"),
      evaluate: (next) =>
        new Promise((resolve) => {
          request = next;
          console.log(`Running ${next.agent} on ${next.scenarios.join(", ")}.`);
          next.onRun("20261118T120000Z-random");
          finish = (ok) => {
            if (ok) console.log("telecom: 2 answered");
            resolve(ok);
          };
          next.signal.addEventListener("abort", () => {
            console.error(
              "Stopped. Resume with: pnpm evorca evaluate --resume=20261118T120000Z-random",
            );
          });
        }),
    };
    await open(width, height);
  }

  async function show(): Promise<string> {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    frames.push(frame);
    return frame;
  }

  async function until(text: string): Promise<string> {
    for (let tries = 0; tries < 100; tries++) {
      await act(() => sleep(10));
      const frame = await show();
      if (frame.includes(text)) return frame;
    }
    throw new Error(`No frame showed ${text}:\n${setup.captureCharFrame()}`);
  }

  async function keys(...names: string[]): Promise<string> {
    for (const name of names) {
      await act(async () => {
        if (name === "enter") setup.mockInput.pressEnter();
        else if (name === "escape") {
          setup.mockInput.pressEscape();
          clock.setTime(clock.now() + 100);
        } else if (name === "ctrl+c") setup.mockInput.pressCtrlC();
        else if (name === "up" || name === "down" || name === "left" || name === "right") {
          setup.mockInput.pressArrow(name);
        } else await setup.mockInput.typeText(name);
      });
    }
    await act(() => sleep(20));
    return show();
  }

  async function confirmRun() {
    await openWithData();
    await enter("/benchmark");
    await until("Scenarios");
    await keys(" ", "down", " ", "enter");
    await keys("down", "down", "down", "down", "h", "enter");
    await keys("down", "right", "enter");
    return show();
  }

  it("lists each scenario with its tasks and telemetry, and how to fetch one without tasks", async () => {
    await openWithData();
    await enter("/benchmark");
    const frame = await until("Scenarios");

    expect(frame).toMatch(/› • bank +2 tasks, no telemetry/);
    expect(frame).toMatch(/ • telecom +3 tasks, with telemetry/);
    expect(frame).toMatch(
      / × market-cloudbed-1 +Fetch its tasks with pnpm evorca fetch --benchmark=openrca --scenario=market-cloudbed-1 *\n/,
    );
  });

  it("shows each task's row, task index, difficulty, and instruction, and drops a difficulty", async () => {
    await openWithData();
    await enter("/benchmark");
    await until("Scenarios");
    await keys(" ", "down", " ", "enter");
    const tasks = await keys("down", "down", "down", "down");
    const hardDropped = await keys("h");

    expect(tasks).toMatch(/ • telecom +3 of 3 tasks/);
    expect(tasks).toMatch(/› • +000 +task_1 +easy +Find the cause of failure 0\./);
    expect(tasks).toMatch(/ • +002 +task_7 +hard +Find the cause of failure 2\./);
    expect(hardDropped).toMatch(/ • telecom +2 of 3 tasks/);
  });

  it("confirms with the command that repeats the pick", async () => {
    const frame = await confirmRun();

    expect(frame).toMatch(/tasks +4 per run: bank 2 of 2, telecom 2 of 3/);
    expect(frame).toMatch(/agent +random, 2 runs, seed \d+/);
    expect(frame.replaceAll(/ \\ *\n +/g, " ")).toMatch(
      /command +EVORCA_SEED=\d+ pnpm evorca evaluate --benchmark=openrca --agent=random --scenario=bank --scenario=telecom --rows=telecom:0,1 --runs=2 *\n/,
    );
  });

  it("says to choose a task on a line of its own when the tasks fill the step", async () => {
    await openWithData(120, 14);
    await enter("/benchmark");
    await until("Scenarios");
    await keys(" ", "down", " ", "enter");
    const frame = await keys(" ", "down", "down", "down", " ", "enter");

    expect(frame).toMatch(/\n +Choose a task\. *\n/);
    expect(frame).toMatch(/› • telecom +0 of 3 tasks *\n/);
    expect(frame).toMatch(/ • +000 +task_1 +easy +Find the cause of failure 0\. *\n/);
  });

  it("keeps the last task in view when the cursor reaches it", async () => {
    await openWithData(120, 14);
    await enter("/benchmark");
    await until("Scenarios");
    await keys(" ", "down", " ", "enter");
    const frame = await keys("down", "down", "down", "down", "down", "down");

    expect(frame).toMatch(/› • +002 +task_7 +hard +Find the cause of failure 2\. *\n/);
  });

  it.each([80, 100, 120])(
    "shows and logs a command with many rows that runs the pick when copied from %i columns",
    async (width) => {
      const wordsAfter = (frame: string, label: RegExp) => {
        const lines = frame.split("\n");
        const first = lines.findIndex((line) => label.test(line));
        const end = lines.findIndex((line, index) => index > first && !/^ {12}/.test(line));
        const copied = [lines[first]?.replace(label, "") ?? "", ...lines.slice(first + 1, end)];
        return copied
          .map((line) => line.trim())
          .join("\n")
          .replaceAll("\\\n", "")
          .split(/\s+/)
          .filter((word) => word !== "");
      };
      const indices = ["task_1", "task_4", "task_7"] as const;
      await openWithData(
        width,
        30,
        Array.from({ length: 90 }, (_, row) => indices[row % 3] ?? "task_1"),
      );
      await enter("/benchmark");
      await until("Scenarios");
      await keys(" ", "enter");
      await keys("e", "enter");
      const shown = wordsAfter(await keys("down", "right", "enter"), /^ +command /);
      await keys("enter");
      await act(async () => finish(true));
      const logged = wordsAfter(
        await until("telecom: 2 answered"),
        /^.*Running the evaluation that this command repeats:/,
      );

      for (const words of [shown, logged]) {
        expect(words.filter((word) => !word.startsWith("--rows="))).toEqual([
          expect.stringMatching(/^EVORCA_SEED=\d+$/),
          "pnpm",
          "evorca",
          "evaluate",
          "--benchmark=openrca",
          "--agent=random",
          "--scenario=bank",
          "--runs=2",
        ]);
        expect(
          parseRows(
            words.filter((word) => word.startsWith("--rows=")).map((word) => word.slice(7)),
            ["bank"],
          ),
        ).toEqual(request?.rows);
      }
      expect(request?.rows.get("bank")).toHaveLength(60);
    },
  );

  it("runs the pick in the view of a run, then logs the command and what the run printed", async () => {
    await confirmRun();
    const running = await keys("enter");

    expect(request).toMatchObject({
      agent: "random",
      scenarios: ["bank", "telecom"],
      rows: new Map([["telecom", [0, 1]]]),
      runs: 2,
      model: undefined,
    });
    expect(running).toContain("Running random on bank, telecom.");
    expect(running).toContain("ctrl+c stop");

    await act(async () => finish(true));
    const logged = await until("telecom: 2 answered");
    const help = await enter("/help");

    expect(logged).toMatch(/evorca +Running the evaluation that this command repeats:/);
    expect(logged).toMatch(/evorca +Running random on bank, telecom\./);
    expect(help).toMatch(/\/help +List the commands/);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("stops the run on ctrl+c, and leaves at once on a second ctrl+c", async () => {
    await confirmRun();
    await keys("enter");
    const stopping = await keys("ctrl+c");

    expect(request?.signal.aborted).toBe(true);
    expect(stopping).toContain("Stopping. Press ctrl+c again to stop at once.");
    expect(onExit).not.toHaveBeenCalled();

    await keys("ctrl+c");

    expect(onExit).toHaveBeenCalledWith(
      expect.arrayContaining(["Running random on bank, telecom."]),
      130,
    );
  });

  it("logs the stop and goes back to the session once the run has stopped", async () => {
    await confirmRun();
    await keys("enter", "ctrl+c");
    await act(async () => finish(false));
    const logged = await until("Stopped. Resume with");

    expect(logged).toMatch(/evorca +Stopping\. Press ctrl\+c again to stop at once\./);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("asks before /exit stops a run, then leaves once the run has stopped", async () => {
    await confirmRun();
    await keys("enter");
    const asked = await enter("/exit");
    frames.push(asked);

    expect(asked).toContain("Type /exit again to stop it and leave evorca.");
    expect(request?.signal.aborted).toBe(false);

    await enter("/exit");

    expect(request?.signal.aborted).toBe(true);
    expect(onExit).not.toHaveBeenCalled();

    await act(async () => finish(false));

    expect(onExit).toHaveBeenCalledWith(
      expect.arrayContaining([
        "› /exit",
        "Stopped. Resume with: pnpm evorca evaluate --resume=20261118T120000Z-random",
      ]),
    );
  });

  it("goes back to the session when the picker closes", async () => {
    await openWithData();
    await enter("/benchmark");
    await until("Scenarios");
    const frame = await keys("escape");

    expect(frame).toMatch(/evorca +No run started\./);
  });
});
