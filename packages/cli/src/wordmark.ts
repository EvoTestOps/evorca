/**
 * The evorca wordmark: the six letters in a pixel font three terminal rows
 * tall. A cell holds an upper and a lower pixel, so one block character draws
 * either pixel, both, or neither. A pixel is ink (`#`), shadow (`+`), or empty
 * (`.`). Shadow fills the inside of a letter. "evo" is set light and "rca"
 * heavy.
 *
 * @module
 */

/** What part of a cell shows: the letter's ink, the shadow inside the letter, or the background. */
export type Tone = "ink" | "shadow" | "background";

/** The weight of a letter: `light` for "evo", `heavy` for "rca". */
export type Weight = "light" | "heavy";

/** One terminal cell of the wordmark: a block character and the tones of its two colors. */
export type Cell = {
  readonly char: " " | "█" | "▀" | "▄";
  readonly fg: Tone;
  readonly bg: Tone;
  readonly weight: Weight;
};

type Glyph = readonly (readonly [upper: string, lower: string])[];

const glyphs: Readonly<Record<"e" | "v" | "o" | "r" | "c" | "a", Glyph>> = {
  e: [
    ["#####", "#+++#"],
    ["#+++#", "#####"],
    ["#++++", "#####"],
  ],
  v: [
    ["#+++#", "#+++#"],
    ["#+++#", ".#+#."],
    [".#+#.", "..#.."],
  ],
  o: [
    ["#####", "#+++#"],
    ["#+++#", "#+++#"],
    ["#+++#", "#####"],
  ],
  r: [
    ["####", "#..."],
    ["#...", "#..."],
    ["#...", "#..."],
  ],
  c: [
    ["#####", "#++++"],
    ["#++++", "#++++"],
    ["#++++", "#####"],
  ],
  a: [
    ["#####", "....#"],
    ["#####", "#+++#"],
    ["#+++#", "#####"],
  ],
};

const letters: readonly (readonly [keyof typeof glyphs, Weight])[] = [
  ["e", "light"],
  ["v", "light"],
  ["o", "light"],
  ["r", "heavy"],
  ["c", "heavy"],
  ["a", "heavy"],
];

const strength: Readonly<Record<Tone, number>> = { background: 0, shadow: 1, ink: 2 };

/** The wordmark's three rows of cells, top to bottom, with one empty column between letters. */
export const wordmark: readonly (readonly Cell[])[] = [0, 1, 2].map((row) =>
  letters.flatMap(([letter, weight], index) => {
    const [upper = "", lower = ""] = glyphs[letter][row] ?? [];
    const cells = [...upper].map((pixel, x) => cell(tone(pixel), tone(lower[x]), weight));
    return index === 0 ? cells : [cell("background", "background", weight), ...cells];
  }),
);

/** The width of the wordmark in columns. */
export const wordmarkWidth = Math.max(...wordmark.map((row) => row.length));

function tone(pixel: string | undefined): Tone {
  return pixel === "#" ? "ink" : pixel === "+" ? "shadow" : "background";
}

function cell(upper: Tone, lower: Tone, weight: Weight): Cell {
  if (upper === lower) {
    return upper === "ink"
      ? { char: "█", fg: "ink", bg: "background", weight }
      : { char: " ", fg: upper, bg: upper, weight };
  }
  return strength[upper] > strength[lower]
    ? { char: "▀", fg: upper, bg: lower, weight }
    : { char: "▄", fg: lower, bg: upper, weight };
}
