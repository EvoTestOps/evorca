import { RGBA } from "@opentui/core";
import { ManualClock, type TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { palette, Shell } from "./shell.js";

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
let onExit: () => void;

async function open(width = 100, height = 30, directory = "~/incidents") {
  clock = new ManualClock();
  onExit = vi.fn();
  setup = await testRender(<Shell directory={directory} onExit={onExit} />, {
    width,
    height,
    clock,
  });
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
  return /❯ (.*?) *│/.exec(frame)?.[1] ?? "";
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
    expect(frame).toMatch(/╭─+╮ *\n *│ ❯ /);
    expect(frame).toContain("enter send   /help commands   ctrl+c exit");
    expect(frame).toMatch(new RegExp(`~/incidents +evorca v${packageJson.version}`));
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
    expect(frame).toMatch(/┃ +hello +\n +┃ *\n *\n +┃ +No agent is connected yet\./);
    expect(frame).toMatch(/│ ❯ +│/);
    expect(frame).toContain("enter send   /help commands   ctrl+c exit");
    expect(frame).toMatch(new RegExp(`~/incidents +evorca v${packageJson.version}`));
  });

  it("stays home on a blank line", async () => {
    await open();
    await at(1000);
    const frame = await enter("   ");

    expect(leds()).toEqual(wordmark);
    expect(frame).not.toContain("┃");
  });

  it("lists the commands for /help", async () => {
    await open();
    const frame = await enter("/help");

    expect(frame).toMatch(/┃ +\/help +\n/);
    expect(frame).toContain("/help  List the commands");
    expect(frame).toContain("/exit  Exit evorca");
  });

  it("names an unknown command", async () => {
    await open();
    const frame = await enter("/nope");

    expect(frame).toContain("Unknown command /nope. Type /help for commands.");
  });

  it("keeps the newest entry in view", async () => {
    await open();
    for (const word of ["one", "two", "three", "four", "five", "six"]) await enter(word);
    const frame = setup.captureCharFrame();

    expect(frame).not.toMatch(/┃ +one /);
    expect(frame).toMatch(/┃ +six /);
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
