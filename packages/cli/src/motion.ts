/**
 * The timing of the shell's animations: the wordmark's intro sweep and its
 * shimmer, and the placeholder that types out example questions. Every
 * function is pure in the time it takes. `wordmarkFrame` and `typewriter` also
 * return a phase, which says whether the animation moves now and how long the
 * current stretch lasts. The shell drives all of them from one clock, which
 * ticks while any phase moves and sleeps through the stretches where none
 * does.
 *
 * @module
 */

/** A stretch of an animation: whether it changes the screen, and the ms until the stretch ends. */
export type Phase = { readonly moving: boolean; readonly left: number };

/** How often the clock ticks while something moves, in frames per second. */
export const frameRate = 30;

/** How long the wordmark takes to sweep in, in ms. */
export const introDuration = 700;

/** The questions the empty input types out as its placeholder, in turn. */
export const examples = [
  "Why did checkout p99 latency spike at 14:05?",
  "Find the root cause of the 5xx burst on payments",
  "What changed before node-6 started OOM-killing pods?",
] as const;

const intro = { edge: 8 };
const shimmer = { first: 2000, every: 8000, duration: 1200, radius: 6, strength: 0.5 };
const typing = { type: 30, hold: 2000, erase: 12, rest: 400 };
const period = examples.reduce((sum, text) => sum + cycleLength(text), 0);

/**
 * How far column `x` of a wordmark `width` columns wide has faded in, from 0
 * to 1, `t` ms after the shell opened. A soft edge sweeps from left to right
 * and slows as it ends.
 */
export function reveal(t: number, x: number, width: number): number {
  const front = easeOut(clamp(t / introDuration)) * (width + intro.edge);
  return clamp((front - x) / intro.edge);
}

/**
 * How strongly the shimmer lights column `x` of a wordmark `width` columns
 * wide, `t` ms after the shell opened: the share of the way to the brightest
 * gray, from 0 to one half. A soft band crosses the wordmark every 8 s.
 */
export function glint(t: number, x: number, width: number): number {
  const since = t - shimmer.first;
  if (since < 0) return 0;
  const progress = (since % shimmer.every) / shimmer.duration;
  if (progress >= 1) return 0;
  const center = easeInOut(progress) * (width + 2 * shimmer.radius) - shimmer.radius;
  const distance = Math.abs(x - center) / shimmer.radius;
  return distance >= 1 ? 0 : (shimmer.strength * (1 + Math.cos(Math.PI * distance))) / 2;
}

/**
 * The wordmark `t` ms after the shell opened, as the time to draw it at and
 * its phase. The intro plays first, then a shimmer every 8 s. Every frame
 * between them looks alike, so the time to draw at stays at the end of the
 * intro while the wordmark rests.
 */
export function wordmarkFrame(t: number): { readonly at: number; readonly phase: Phase } {
  const phase = wordmarkPhase(t);
  return { at: phase.moving ? t : introDuration, phase };
}

function wordmarkPhase(t: number): Phase {
  if (t < introDuration) return { moving: true, left: introDuration - t };
  const since = t - shimmer.first;
  if (since < 0) return { moving: false, left: -since };
  const into = since % shimmer.every;
  return into < shimmer.duration
    ? { moving: true, left: shimmer.duration - into }
    : { moving: false, left: shimmer.every - into };
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

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function easeOut(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

function easeInOut(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}
