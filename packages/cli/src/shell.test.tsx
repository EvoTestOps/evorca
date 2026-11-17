import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { banner } from "./banner.js";
import { Shell } from "./shell.js";

const placeholder = "Describe an incident to investigate";

let setup: TestRendererSetup;
let onExit: () => void;

async function open(width = 100, height = 30) {
  onExit = vi.fn();
  setup = await testRender(<Shell directory="~/incidents" onExit={onExit} />, { width, height });
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

afterEach(() => act(() => setup.dispose()));

describe("Shell", () => {
  it("shows the banner, the version and directory, the hints, and the input", async () => {
    const frame = await open();

    for (const row of banner) expect(frame).toContain(row);
    expect(frame).toContain(`v${packageJson.version} · ~/incidents`);
    expect(frame).toContain("Type a message, or /help for commands.");
    expect(frame).toContain(placeholder);
    expect(frame).toContain("ctrl+c to exit");
  });

  it("shows the plain name instead of the banner when the terminal narrows", async () => {
    await open();
    await act(async () => setup.resize(40, 30));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();

    expect(frame).not.toContain("█");
    expect(frame).toMatch(/^ +evorca +$/m);
  });

  it("answers a message and clears the input", async () => {
    await open();
    const frame = await enter("hello");

    expect(frame).toMatch(/❯ hello +\n +No agent is connected yet\./);
    expect(frame).toContain(placeholder);
  });

  it("draws text in the terminal's own foreground color", async () => {
    await open();
    await enter("hello");
    await act(async () => setup.mockInput.typeText("draft"));
    await setup.renderOnce();
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);

    for (const text of ["Type a message", "hello", "No agent is connected yet.", "draft"]) {
      expect(spans.find((span) => span.text.includes(text))?.fg.intent, text).toBe("default");
    }
  });

  it("ignores a blank line", async () => {
    const before = await open();

    expect(await enter("   ")).toBe(before);
  });

  it("lists the commands for /help", async () => {
    await open();
    const frame = await enter("/help");

    expect(frame).toContain("❯ /help");
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

    expect(frame).not.toContain("❯ one");
    expect(frame).toContain("❯ six");
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
