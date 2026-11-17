/**
 * The timing of the shell's animations: the boot of the wordmark, where its
 * dots switch on one at a time, the flicker of a few dots now and then, and
 * the placeholder that types out example questions. Every function is pure in
 * the time it takes. `wordmarkFrame` and `typewriter` also return a phase,
 * which says whether the animation moves now and how long the current stretch
 * lasts. The shell drives all of them from one clock, which ticks while any
 * phase moves and sleeps through the stretches where none does.
 *
 * @module
 */
import { litDots } from "./wordmark.js";

/** A stretch of an animation: whether it changes the screen, and the ms until the stretch ends. */
export type Phase = { readonly moving: boolean; readonly left: number };

/** The state of a dot of the wordmark that can light. */
export type Led = "off" | "dim" | "on";

/** How often the clock ticks while something moves, in frames per second. */
export const frameRate = 30;

/** How long the wordmark takes to switch on all of its dots, in ms. */
export const bootDuration = 900;

/** The questions the empty input types out as its placeholder, in turn. */
export const examples = [
  "Why did checkout p99 latency spike at 14:05?",
  "Find the root cause of the 5xx burst on payments",
  "What changed before node-6 started OOM-killing pods?",
] as const;

const flicker = { first: 4000, every: 6000, duration: 150, dots: 3 };
const seeds = { boot: 1, flickerStart: 2, flickerDots: 3 };
const typing = { type: 30, hold: 2000, erase: 12, rest: 400 };
const period = examples.reduce((sum, text) => sum + cycleLength(text), 0);
const bootOrder = Array.from({ length: litDots }, (_, id) => id).sort(
  (a, b) => hash(seeds.boot, a) - hash(seeds.boot, b),
);
const switchOn = Array.from(
  { length: litDots },
  (_, id) => (bootDuration * (bootOrder.indexOf(id) + 1)) / litDots,
);

/**
 * The state of the dot numbered `id`, `t` ms after the shell opened. During
 * the boot, the dots switch on one at a time in a scattered order. After the
 * boot, a few dots dim for a moment every 3 to 9 s.
 */
export function led(t: number, id: number): Led {
  if (t < (switchOn[id] ?? 0)) return "off";
  const { slot, start } = flickerAt(t);
  return t >= start && flickers(slot, id) ? "dim" : "on";
}

/**
 * The wordmark `t` ms after the shell opened, as the time to draw it at and
 * its phase. The boot plays first, then a flicker now and then. Every frame
 * between them looks alike, so the time to draw at stays at the end of the
 * boot while the wordmark rests.
 */
export function wordmarkFrame(t: number): { readonly at: number; readonly phase: Phase } {
  const phase = wordmarkPhase(t);
  return { at: phase.moving ? t : bootDuration, phase };
}

/**
 * The placeholder `elapsed` ms after the input emptied, when it starts from
 * example number `first`. Each example types out, holds, erases, and rests
 * before the next. Before `elapsed` reaches 0, the placeholder rests empty.
 * The example number keeps counting past the end of {@link examples}, which
 * repeat.
 */
export function typewriter(
  elapsed: number,
  first: number,
): { readonly text: string; readonly example: number; readonly phase: Phase } {
  if (elapsed < 0) return { text: "", example: first, phase: { moving: false, left: -elapsed } };
  let index = first;
  let into = elapsed % period;
  while (into >= cycleLength(example(index))) into -= cycleLength(example(index++));
  return { ...cycle(example(index), into), example: index };
}

/**
 * How long the clock can sleep, in ms, given the phases on screen: 0 while
 * any phase moves, and `Infinity` when no phase will move again.
 */
export function sleep(phases: readonly Phase[]): number {
  return phases.some((phase) => phase.moving) ? 0 : Math.min(...phases.map((phase) => phase.left));
}

function wordmarkPhase(t: number): Phase {
  if (t < bootDuration) return { moving: true, left: bootDuration - t };
  const { start } = flickerAt(t);
  return t < start
    ? { moving: false, left: start - t }
    : { moving: true, left: start + flicker.duration - t };
}

function flickerAt(t: number): { readonly slot: number; readonly start: number } {
  const slot = Math.max(0, Math.floor((t - flicker.first) / flicker.every));
  const start = flickerStart(slot);
  return t < start + flicker.duration
    ? { slot, start }
    : { slot: slot + 1, start: flickerStart(slot + 1) };
}

function flickerStart(slot: number): number {
  return flicker.first + flicker.every * (slot + hash(seeds.flickerStart, slot) / 2);
}

function flickers(slot: number, id: number): boolean {
  const spacing = Math.floor(litDots / flicker.dots);
  const offset = (id - Math.floor(hash(seeds.flickerDots, slot) * litDots) + litDots) % litDots;
  return offset % spacing === 0 && offset < spacing * flicker.dots;
}

function hash(seed: number, n: number): number {
  let h = Math.imul(seed, 0x9e3779b9) ^ Math.imul(n, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

function example(index: number): string {
  return examples[index % examples.length] ?? "";
}

function cycleLength(text: string): number {
  return text.length * (typing.type + typing.erase) + typing.hold + typing.rest;
}

function cycle(text: string, into: number): { readonly text: string; readonly phase: Phase } {
  const typed = text.length * typing.type;
  const held = typed + typing.hold;
  const erased = held + text.length * typing.erase;
  if (into < typed) {
    const shown = text.slice(0, Math.floor(into / typing.type));
    return { text: shown, phase: { moving: true, left: typed - into } };
  }
  if (into < held) return { text, phase: { moving: false, left: held - into } };
  if (into < erased) {
    const shown = text.slice(0, text.length - Math.floor((into - held) / typing.erase));
    return { text: shown, phase: { moving: true, left: erased - into } };
  }
  return { text: "", phase: { moving: false, left: cycleLength(text) - into } };
}
