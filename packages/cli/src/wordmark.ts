/**
 * The evorca wordmark as an LED dot matrix: the six letters in a dot font
 * five dots wide and seven tall, set on one panel with a column of dots
 * between letters. Every position on the panel holds a dot. The dots of the
 * letters can light, and the rest stay dark, so the whole panel shows.
 *
 * @module
 */

type Letter = "e" | "v" | "o" | "r" | "c" | "a";

const font: Readonly<Record<Letter, readonly string[]>> = {
  e: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  v: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  o: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  r: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  c: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  a: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
};

const word: readonly Letter[] = ["e", "v", "o", "r", "c", "a"];

/**
 * One position on the panel. A dot of a letter can light and has an `id`,
 * which counts those dots in reading order from 0. Any other dot stays dark.
 */
export type Dot = { readonly lit: true; readonly id: number } | { readonly lit: false };

const pattern = font.e.map((_, y) => word.map((letter) => font[letter][y]).join("."));
let next = 0;

/** The rows of the panel, top to bottom. */
export const panel: readonly (readonly Dot[])[] = pattern.map((row) =>
  [...row].map((pixel): Dot => (pixel === "#" ? { lit: true, id: next++ } : { lit: false })),
);

/** The number of dots that light. */
export const litDots = next;
