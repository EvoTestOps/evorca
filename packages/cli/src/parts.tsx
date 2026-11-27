/**
 * The parts that every evorca screen draws: the grays, the gutter, the name
 * evorca, a line of keys, and the footer. The shell, the picker of
 * `/benchmark`, and the view of `evorca watch` share them, so they live apart
 * from each.
 *
 * @module
 */
// @jsxRuntime automatic
// @jsxImportSource @opentui/react
import { sep } from "node:path";
import { TextAttributes } from "@opentui/core";
import packageJson from "../package.json" with { type: "json" };

/** The grays that evorca draws with, each with equal red, green, and blue. */
export const palette = {
  background: "#0a0a0a",
  border: "#333333",
  muted: "#707070",
  text: "#c8c8c8",
  bright: "#f4f4f4",
} as const;

/** The space in columns between the edge of the screen and the content. */
export const gutter = 2;
const version = `evorca v${packageJson.version}`;
const separator = "   ";

/** The name evorca in bold, with `evo` dimmer than `rca`. */
export function Mark() {
  return (
    <text attributes={TextAttributes.BOLD}>
      <span fg={palette.muted}>evo</span>
      <span fg={palette.bright}>rca</span>
    </text>
  );
}

/**
 * A line of keys and what they do. When the line is wider than `width`, it
 * drops hints from the start until it fits.
 */
export function Hints({
  hints,
  width,
}: {
  readonly hints: readonly (readonly [string, string])[];
  readonly width: number;
}) {
  const shown = hints.filter((_, index) => hintsWidth(hints.slice(index)) <= width);
  return (
    <text flexShrink={0}>
      {shown.map(([key, label], index) => (
        <span key={key}>
          <span fg={palette.bright}>{key}</span>
          <span fg={palette.muted}>{` ${label}${index < shown.length - 1 ? separator : ""}`}</span>
        </span>
      ))}
    </text>
  );
}

/** The bottom line: `directory`, shortened to fit `width`, and the version. */
export function Footer({
  directory,
  width,
}: {
  readonly directory: string;
  readonly width: number;
}) {
  return (
    <box flexDirection="row" paddingX={gutter} paddingY={1} flexShrink={0}>
      <text fg={palette.muted}>{shorten(directory, width - 2 * gutter - version.length - 2)}</text>
      <box flexGrow={1} />
      <text fg={palette.muted} flexShrink={0}>
        {version}
      </text>
    </box>
  );
}

function hintsWidth(shown: readonly (readonly [string, string])[]): number {
  return (
    shown.reduce((sum, [key, label]) => sum + key.length + 1 + label.length, 0) +
    separator.length * (shown.length - 1)
  );
}

function shorten(path: string, max: number): string {
  const segments = path.split(sep);
  for (let start = 0; start < segments.length; start++) {
    const shown = start === 0 ? path : `…${sep}${segments.slice(start).join(sep)}`;
    if (shown.length <= max) return shown;
  }
  return `…${path.slice(path.length - Math.max(0, max - 1))}`;
}
