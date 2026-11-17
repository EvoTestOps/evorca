/**
 * The interactive shell that `evorca` opens without arguments. It starts on a
 * home screen with the wordmark and the input box in the middle. Once a line
 * adds to the transcript, it shows the session view instead, with the
 * transcript above an input box pinned to the bottom. It applies the outcome
 * that `commands.ts` returns for each line, and draws only grays.
 *
 * The JSX pragmas below repeat `tsconfig.json`, because `pnpm evorca` runs tsx
 * from the repository root, where tsx finds no `tsconfig.json`.
 *
 * @module
 */
// @jsxRuntime automatic
// @jsxImportSource @opentui/react
import { homedir } from "node:os";
import { sep } from "node:path";
import {
  createCliRenderer,
  RGBA,
  TextAttributes,
  type BorderCharacters,
  type InputRenderable,
} from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { memo, useRef, useState } from "react";
import packageJson from "../package.json" with { type: "json" };
import { submit, type Entry } from "./commands.js";
import { wordmark, wordmarkWidth, type Tone, type Weight } from "./wordmark.js";

/**
 * The grays the shell draws with, each with equal red, green, and blue. The
 * wordmark blends them.
 */
export const palette = {
  background: "#0a0a0a",
  panel: "#161616",
  border: "#333333",
  muted: "#707070",
  text: "#c8c8c8",
  bright: "#f4f4f4",
} as const;

type Voice = {
  readonly bar: string;
  readonly fg: string;
  readonly panel?: string;
  readonly paddingY: number;
};

type View =
  { readonly view: "home" } | { readonly view: "session"; readonly transcript: readonly Entry[] };

const gutter = 2;
const promptWidth = 75;
const tagline = "autonomous incident investigation";
const placeholder = "Describe an incident to investigate";
const version = `evorca v${packageJson.version}`;
const hints = [
  ["enter", "send"],
  ["/help", "commands"],
  ["ctrl+c", "exit"],
] as const;
const separator = "   ";
const bar: BorderCharacters = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "┃",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
};
const voices: Readonly<Record<Entry["role"], Voice>> = {
  you: { bar: palette.bright, fg: palette.bright, panel: palette.panel, paddingY: 1 },
  evorca: { bar: palette.muted, fg: palette.text, paddingY: 0 },
};

const background = RGBA.fromHex(palette.background);
const inks: Readonly<Record<Weight, RGBA>> = {
  light: RGBA.fromHex(palette.muted),
  heavy: RGBA.fromHex(palette.bright),
};

/**
 * Draws the shell full screen for the working directory. The shell runs until
 * the user exits it.
 */
export async function openShell(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: false,
    backgroundColor: palette.background,
  });
  createRoot(renderer).render(
    <Shell directory={tildify(process.cwd())} onExit={() => renderer.destroy()} />,
  );
}

/** The props of {@link Shell}. `directory` is the working directory as the user should read it. */
export type ShellProps = { readonly directory: string; readonly onExit: () => void };

/** The whole screen. It calls `onExit` on `/exit` and on ctrl+c. */
export function Shell({ directory, onExit }: ShellProps) {
  const { width } = useTerminalDimensions();
  const [view, setView] = useState<View>({ view: "home" });
  const input = useRef<InputRenderable>(null);
  const home = view.view === "home";

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") onExit();
  });

  function onSubmit(line: string) {
    if (input.current) input.current.value = "";
    const outcome = submit(line);
    if (outcome.kind === "exit") return onExit();
    if (outcome.entries.length === 0) return;
    setView((view) => ({
      view: "session",
      transcript: [...(view.view === "session" ? view.transcript : []), ...outcome.entries],
    }));
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.background}>
      <box flexDirection="column" flexGrow={1} alignItems="center" paddingX={gutter} paddingTop={1}>
        {home ? <box flexGrow={1} /> : null}
        {view.view === "session" ? (
          <Transcript entries={view.transcript} />
        ) : (
          <Masthead wide={width >= wordmarkWidth + 2 * gutter} />
        )}
        <box
          flexDirection="column"
          width="100%"
          maxWidth={home ? promptWidth : undefined}
          flexShrink={0}
          marginTop={home ? 2 : 1}
        >
          <box
            border
            borderStyle="rounded"
            borderColor={palette.border}
            paddingX={1}
            flexDirection="row"
          >
            <text fg={palette.muted} flexShrink={0}>
              {"❯ "}
            </text>
            <input
              ref={input}
              focused
              flexGrow={1}
              flexShrink={1}
              placeholder={placeholder}
              placeholderColor={palette.muted}
              textColor={palette.bright}
              focusedTextColor={palette.bright}
              cursorColor={palette.bright}
              onSubmit={onSubmit}
            />
          </box>
          <Hints width={width - 2 * gutter} />
        </box>
        {home ? <box flexGrow={1} /> : null}
      </box>
      <Footer directory={directory} width={width} />
    </box>
  );
}

function Masthead({ wide }: { readonly wide: boolean }) {
  return (
    <box flexDirection="column" alignItems="center" flexShrink={0}>
      {wide ? (
        <Wordmark />
      ) : (
        <text attributes={TextAttributes.BOLD}>
          <span fg={palette.muted}>evo</span>
          <span fg={palette.bright}>rca</span>
        </text>
      )}
      <text fg={palette.muted} marginTop={1}>
        {tagline}
      </text>
    </box>
  );
}

function Wordmark() {
  return (
    <box flexDirection="column" flexShrink={0}>
      {wordmark.map((row, y) => (
        <text key={y}>
          {row.map((cell, x) => (
            <span
              key={x}
              fg={paint(cell.fg, cell.weight)}
              bg={paint(cell.bg, cell.weight)}
              attributes={cell.weight === "heavy" ? TextAttributes.BOLD : 0}
            >
              {cell.char}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}

const Transcript = memo(function Transcript({ entries }: { readonly entries: readonly Entry[] }) {
  return (
    <scrollbox
      stickyScroll
      stickyStart="bottom"
      scrollbarOptions={{ visible: false }}
      flexGrow={1}
      width="100%"
    >
      {entries.map((entry, index) => {
        const voice = voices[entry.role];
        return (
          <box
            key={index}
            border={["left"]}
            customBorderChars={bar}
            borderColor={voice.bar}
            backgroundColor={voice.panel}
            paddingX={2}
            paddingY={voice.paddingY}
            marginTop={index > 0 ? 1 : 0}
          >
            <text fg={voice.fg}>{entry.text}</text>
          </box>
        );
      })}
    </scrollbox>
  );
});

function Hints({ width }: { readonly width: number }) {
  const shown = hints.filter((_, index) => hintsWidth(hints.slice(index)) + 2 <= width);
  return (
    <text paddingLeft={2} flexShrink={0}>
      {shown.map(([key, label], index) => (
        <span key={key}>
          <span fg={palette.bright}>{key}</span>
          <span fg={palette.muted}>{` ${label}${index < shown.length - 1 ? separator : ""}`}</span>
        </span>
      ))}
    </text>
  );
}

function Footer({ directory, width }: { readonly directory: string; readonly width: number }) {
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

function paint(tone: Tone, weight: Weight): RGBA {
  if (tone === "background") return background;
  return tone === "ink" ? inks[weight] : mix(background, inks[weight], 0.25);
}

function mix(from: RGBA, to: RGBA, t: number): RGBA {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return RGBA.fromValues(lerp(from.r, to.r), lerp(from.g, to.g), lerp(from.b, to.b));
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

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
