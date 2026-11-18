/**
 * The interactive shell that `evorca` opens without arguments. It starts on a
 * home screen with the wordmark and the input line in the middle. Once a line
 * adds to the transcript, it shows the session view instead, with the
 * transcript as a log with timestamps above an input line pinned to the
 * bottom. It applies the outcome that `commands.ts` returns for each line, and
 * draws only grays.
 *
 * `/benchmark` opens the picker of `benchmark-view.tsx` in place of the
 * transcript, then runs the pick in this process and shows it in the view of
 * `evorca watch`, with the input line under it. What the run prints joins the
 * transcript when the run ends. Ctrl+c stops the run as it stops `evorca
 * evaluate`, and a second ctrl+c leaves at once. While a run goes, the input
 * line takes only `/exit`, which asks first, then stops the run and leaves
 * once it has stopped. Leaving during a run prints what it printed.
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
import { randomInt } from "node:crypto";
import { homedir } from "node:os";
import { sep } from "node:path";
import { createCliRenderer, type InputRenderable } from "@opentui/core";
import {
  createRoot,
  useAnimationTick,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { memo, useEffect, useRef, useState } from "react";
import { commandOf, readCatalog, type Catalog, type Plan } from "./benchmark.js";
import { BenchmarkPicker } from "./benchmark-view.js";
import { submit, type Entry } from "./commands.js";
import { captureConsole, followRuns } from "./evaluate-view.js";
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
import { Footer, gutter, Hints, Mark, palette } from "./parts.js";
import type { Frame } from "./watch-folder.js";
import { Watch } from "./watch-view.js";
import type { Selection } from "./watch.js";
import { panel } from "./wordmark.js";

type Voice = { readonly speaker: string; readonly text: string };

type Screen =
  | { readonly kind: "log" }
  | { readonly kind: "picker"; readonly catalog: Catalog; readonly seed: number }
  | { readonly kind: "run"; readonly run: Run };

type Run = {
  readonly read: (selection: Selection) => Promise<Frame>;
  readonly stop: AbortController;
  readonly entries: Entry[];
  exit: "no" | "asked" | "confirmed";
};

type Draft =
  | { readonly kind: "empty"; readonly typingFrom: number; readonly firstExample: number }
  | { readonly kind: "text"; readonly nextExample: number };

const promptWidth = 75;
const tagline = "autonomous incident investigation";
const hints = [
  ["enter", "send"],
  ["/help", "commands"],
  ["ctrl+c", "exit"],
] as const;
const rule = { border: ["bottom" as const], borderColor: palette.border };
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
export async function openShell(bench: Bench): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: false,
    backgroundColor: palette.background,
  });
  createRoot(renderer).render(
    <Shell
      directory={tildify(process.cwd())}
      wallTime={() => new Date()}
      bench={bench}
      onExit={(lines = [], code) => {
        renderer.destroy();
        void renderer.closed.then(() => {
          for (const line of lines) process.stdout.write(`${line}\n`);
          if (code !== undefined) process.exit(code);
        });
      }}
    />,
  );
}

/**
 * What `/benchmark` needs: the folders of the benchmark's data and of its
 * runs, and `evaluate`, which runs a plan as `evorca evaluate` does.
 */
export type Bench = {
  readonly dataDir: string;
  readonly runsDir: string;
  readonly evaluate: (
    request: Plan & { readonly signal: AbortSignal; readonly onRun: (runId: string) => void },
  ) => Promise<boolean>;
};

/**
 * The props of {@link Shell}. `directory` is the working directory as the user
 * should read it, and `wallTime` returns the local time to stamp each entry
 * of the transcript with. `onExit` closes the shell, then prints `lines` and
 * ends the process with `code` if they are given.
 */
export type ShellProps = {
  readonly directory: string;
  readonly wallTime: () => Date;
  readonly bench: Bench;
  readonly onExit: (lines?: readonly string[], code?: number) => void;
};

/** The whole screen. It calls `onExit` on `/exit` and on ctrl+c. */
export function Shell({ directory, wallTime, bench, onExit }: ShellProps) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const [start] = useState(() => renderer.clock.now());
  const [transcript, setTranscript] = useState<readonly Entry[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: "log" });
  const [draft, setDraft] = useState<Draft>({
    kind: "empty",
    typingFrom: start + bootDuration,
    firstExample: 0,
  });
  const [, setFrame] = useState(start);
  const input = useRef<InputRenderable>(null);

  const now = renderer.clock.now();
  const home = screen.kind === "log" && transcript.length === 0;
  const showWordmark = home && width >= wordmarkWidth + 2 * gutter;
  const mark = wordmarkFrame(now - start);
  const placeholder =
    screen.kind === "log" && draft.kind === "empty"
      ? typewriter(now - draft.typingFrom, draft.firstExample)
      : null;
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
    if (!key.ctrl || key.name !== "c") return;
    if (screen.kind !== "run") return onExit();
    const { run } = screen;
    if (run.stop.signal.aborted) return onExit(texts(run.entries), 130);
    say(run, "Stopping. Press ctrl+c again to stop at once.");
    run.stop.abort();
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
    if (screen.kind === "run") {
      if (line.trim() !== "") whileRunning(screen.run, line.trim(), outcome.kind === "exit");
      return;
    }
    if (outcome.kind === "exit") return onExit();
    setTranscript((transcript) => [...transcript, ...outcome.entries]);
    if (outcome.kind === "benchmark") openPicker();
  }

  function whileRunning(run: Run, text: string, exit: boolean) {
    run.entries.push({ role: "you", text, at: wallTime() });
    if (!exit) {
      return say(run, "A run is going. /exit stops it and leaves, and ctrl+c stops it.");
    }
    if (run.exit === "no") {
      run.exit = "asked";
      return say(run, "A run is going. Type /exit again to stop it and leave evorca.");
    }
    run.exit = "confirmed";
    run.stop.abort();
    say(run, "Stopping. evorca leaves once the run has stopped.");
  }

  function say(run: Run, text: string) {
    run.entries.push({ role: "evorca", text, at: wallTime() });
    setScreen({ kind: "run", run });
  }

  function openPicker() {
    readCatalog(bench.dataDir, bench.runsDir).then(
      (catalog) => setScreen({ kind: "picker", catalog, seed: randomInt(2 ** 32) }),
      (error: unknown) => append(error instanceof Error ? error.message : String(error)),
    );
  }

  function append(text: string) {
    setTranscript((transcript) => [...transcript, { role: "evorca", text, at: wallTime() }]);
  }

  async function runPlan(plan: Plan) {
    append(`Running the evaluation that this command repeats:\n${commandOf(plan)}`);
    const { read, onRun } = followRuns({ ...bench, scenarios: plan.scenarios });
    const run: Run = { read, stop: new AbortController(), entries: [], exit: "no" };
    setScreen({ kind: "run", run });
    const restore = captureConsole(({ text }) => {
      run.entries.push({ role: "evorca", text, at: wallTime() });
    });
    try {
      await bench.evaluate({ ...plan, signal: run.stop.signal, onRun });
    } catch (error: unknown) {
      run.entries.push({ role: "evorca", text: String(error), at: wallTime() });
    } finally {
      restore();
    }
    if (run.exit === "confirmed") return onExit(texts(run.entries));
    setTranscript((transcript) => [...transcript, ...run.entries]);
    setScreen({ kind: "log" });
  }

  const prompt = (
    <box {...(screen.kind === "run" ? {} : rule)} flexDirection="row" flexShrink={0}>
      <text fg={palette.muted} flexShrink={0}>
        {"› "}
      </text>
      <input
        ref={input}
        focused
        flexGrow={1}
        flexShrink={1}
        placeholder={
          screen.kind === "run" ? "/exit to stop the run and leave" : (placeholder?.text ?? "")
        }
        placeholderColor={palette.muted}
        textColor={palette.bright}
        focusedTextColor={palette.bright}
        cursorColor={palette.bright}
        onInput={onInput}
        onSubmit={onSubmit}
      />
    </box>
  );

  if (screen.kind === "run") {
    const { run } = screen;
    return (
      <Watch
        read={run.read}
        wallTime={wallTime}
        log={() => texts(run.entries)}
        keys={draft.kind === "empty"}
      >
        <box flexShrink={0} marginTop={1}>
          {prompt}
        </box>
      </Watch>
    );
  }
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.background}>
      <box flexDirection="column" flexGrow={1} alignItems="center" paddingX={gutter} paddingTop={1}>
        {home ? <box flexGrow={1} /> : null}
        {screen.kind === "picker" ? (
          <BenchmarkPicker
            catalog={screen.catalog}
            seed={screen.seed}
            onCancel={() => {
              append("No run started.");
              setScreen({ kind: "log" });
            }}
            onStart={(plan) => void runPlan(plan)}
          />
        ) : home ? (
          <Masthead wordmarkAt={showWordmark ? mark.at : null} />
        ) : (
          <Transcript entries={transcript} />
        )}
        {screen.kind === "picker" ? null : (
          <box
            flexDirection="column"
            width="100%"
            maxWidth={home ? promptWidth : undefined}
            flexShrink={0}
            marginTop={home ? 2 : 1}
          >
            {prompt}
            <Hints hints={hints} width={width - 2 * gutter} />
          </box>
        )}
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

function texts(entries: readonly Entry[]): string[] {
  return entries.flatMap(({ role, text }) => (role === "you" ? `› ${text}` : text).split("\n"));
}

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
