/**
 * The interactive shell that `evorca` opens without arguments. It starts on a
 * home screen with the wordmark and the input line in the middle. Once a line
 * adds to the transcript, it shows the session view instead, with the
 * transcript as a log with timestamps above an input line pinned to the
 * bottom. It applies the outcome that `commands.ts` returns for each line, and
 * draws only grays.
 *
 * One clock drives the animations in `motion.ts`. It ticks while one of them
 * moves, sleeps until the next one moves, and stops when none will.
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
import { createCliRenderer, TextAttributes, type InputRenderable } from "@opentui/core";
import {
  createRoot,
  useAnimationTick,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { memo, useEffect, useRef, useState } from "react";
import packageJson from "../package.json" with { type: "json" };
import { submit, type Entry } from "./commands.js";
import {
  bootDuration,
  frameRate,
  led,
  sleep,
  typewriter,
  wordmarkFrame,
  type Led,
  type Phase,
} from "./motion.js";
import { panel } from "./wordmark.js";

/** The grays the shell draws with, each with equal red, green, and blue. */
export const palette = {
  background: "#0a0a0a",
  border: "#333333",
  muted: "#707070",
  text: "#c8c8c8",
  bright: "#f4f4f4",
} as const;

type Voice = { readonly speaker: string; readonly text: string };

type View =
  { readonly view: "home" } | { readonly view: "session"; readonly transcript: readonly Entry[] };

type Draft =
  | { readonly kind: "empty"; readonly typingFrom: number; readonly firstExample: number }
  | { readonly kind: "text"; readonly nextExample: number };

/** The space in columns between the edge of the screen and the content. */
export const gutter = 2;
const promptWidth = 75;
const tagline = "autonomous incident investigation";
const version = `evorca v${packageJson.version}`;
const hints = [
  ["enter", "send"],
  ["/help", "commands"],
  ["ctrl+c", "exit"],
] as const;
const separator = "   ";
const dot = "•";
const wordmarkWidth = (panel[0]?.length ?? 0) * 2 - 1;
const voices: Readonly<Record<Entry["role"], Voice>> = {
  you: { speaker: palette.bright, text: palette.bright },
  evorca: { speaker: palette.muted, text: palette.text },
};
const speakerWidth = Math.max(...Object.keys(voices).map((role) => role.length));
const inks: Readonly<Record<Led, string>> = {
  off: palette.border,
  dim: palette.muted,
  on: palette.bright,
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
    <Shell
      directory={tildify(process.cwd())}
      wallTime={() => new Date()}
      onExit={() => renderer.destroy()}
    />,
  );
}

/**
 * The props of {@link Shell}. `directory` is the working directory as the user
 * should read it, and `wallTime` returns the local time to stamp each entry
 * of the transcript with.
 */
export type ShellProps = {
  readonly directory: string;
  readonly wallTime: () => Date;
  readonly onExit: () => void;
};

/** The whole screen. It calls `onExit` on `/exit` and on ctrl+c. */
export function Shell({ directory, wallTime, onExit }: ShellProps) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const [start] = useState(() => renderer.clock.now());
  const [view, setView] = useState<View>({ view: "home" });
  const [draft, setDraft] = useState<Draft>({
    kind: "empty",
    typingFrom: start + bootDuration,
    firstExample: 0,
  });
  const [, setFrame] = useState(start);
  const input = useRef<InputRenderable>(null);

  const now = renderer.clock.now();
  const home = view.view === "home";
  const showWordmark = home && width >= wordmarkWidth + 2 * gutter;
  const mark = wordmarkFrame(now - start);
  const placeholder =
    draft.kind === "empty" ? typewriter(now - draft.typingFrom, draft.firstExample) : null;
  const phases: Phase[] = [];
  if (showWordmark) phases.push(mark.phase);
  if (placeholder) phases.push(placeholder.phase);
  const rest = sleep(phases);

  useAnimationTick(rest === 0 ? frameRate : undefined, (_delta, _ticks, time) => setFrame(time));
  useEffect(() => {
    if (rest === 0 || rest === Infinity) return;
    const timer = renderer.clock.setTimeout(() => setFrame(renderer.clock.now()), rest);
    return () => renderer.clock.clearTimeout(timer);
  }, [renderer, now, rest]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") onExit();
  });

  function onInput(value: string) {
    const time = renderer.clock.now();
    setDraft((draft) => {
      if (value === "") {
        return draft.kind === "empty"
          ? draft
          : { kind: "empty", typingFrom: time, firstExample: draft.nextExample };
      }
      if (draft.kind === "text") return draft;
      const shown = typewriter(time - draft.typingFrom, draft.firstExample);
      return { kind: "text", nextExample: shown.example + 1 };
    });
  }

  function onSubmit(line: string) {
    if (input.current) input.current.value = "";
    const outcome = submit(line, wallTime());
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
          <Masthead wordmarkAt={showWordmark ? mark.at : null} />
        )}
        <box
          flexDirection="column"
          width="100%"
          maxWidth={home ? promptWidth : undefined}
          flexShrink={0}
          marginTop={home ? 2 : 1}
        >
          <box border={["bottom"]} borderColor={palette.border} flexDirection="row">
            <text fg={palette.muted} flexShrink={0}>
              {"› "}
            </text>
            <input
              ref={input}
              focused
              flexGrow={1}
              flexShrink={1}
              placeholder={placeholder?.text ?? ""}
              placeholderColor={palette.muted}
              textColor={palette.bright}
              focusedTextColor={palette.bright}
              cursorColor={palette.bright}
              onInput={onInput}
              onSubmit={onSubmit}
            />
          </box>
          <Hints hints={hints} width={width - 2 * gutter} />
        </box>
        {home ? <box flexGrow={1} /> : null}
      </box>
      <Footer directory={directory} width={width} />
    </box>
  );
}

const Masthead = memo(function Masthead({ wordmarkAt }: { readonly wordmarkAt: number | null }) {
  return (
    <box flexDirection="column" alignItems="center" flexShrink={0}>
      {wordmarkAt === null ? <Mark /> : <Wordmark t={wordmarkAt} />}
      <text fg={palette.muted} marginTop={1}>
        {tagline}
      </text>
    </box>
  );
});

function Wordmark({ t }: { readonly t: number }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {panel.map((row, y) => (
        <text key={y}>
          {row.map((spot, x) => (
            <span key={x} fg={inks[spot.lit ? led(t, spot.id) : "off"]}>
              {x === 0 ? dot : ` ${dot}`}
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
            flexDirection="row"
            gap={2}
            marginTop={entry.role === "you" && index > 0 ? 1 : 0}
          >
            <text fg={palette.muted} flexShrink={0}>
              {entry.at.toTimeString().slice(0, 8)}
            </text>
            <text fg={voice.speaker} flexShrink={0}>
              {entry.role.padEnd(speakerWidth)}
            </text>
            <text fg={voice.text}>{entry.text}</text>
          </box>
        );
      })}
    </scrollbox>
  );
});

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

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
