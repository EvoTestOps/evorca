/**
 * `evorca evaluate` in a terminal: the run full screen in the view of `evorca
 * watch`, with the last lines that the runner printed under the feed. When
 * the runner settles, the view closes, the terminal is restored, and every
 * line that the runner printed goes to stdout or stderr in order. So the
 * scrollback holds the same text as a plain run, the score tables among it.
 *
 * Ctrl+c in the view sends SIGINT to the process, as ctrl+c does in a plain
 * terminal. When SIGINT or SIGTERM comes and nothing else handles it, so that
 * the signal ends the process, the view closes and prints the lines first.
 *
 * A view that throws while it draws shows the error in place of the run, and
 * ctrl+c still reaches the runner, because the key is read outside the view.
 * An uncaught error closes the view and prints the lines and the error, and
 * the run goes on with plain lines.
 *
 * @module
 */
// @jsxRuntime automatic
// @jsxImportSource @opentui/react
import { format } from "node:util";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { palette } from "./shell.js";
import { readRunFolders, type Frame, type RunFolders } from "./watch-folder.js";
import { Watch } from "./watch-view.js";
import type { Selection } from "./watch.js";

/** A line that the runner printed, and the stream it was meant for. */
export type LogLine = { readonly text: string; readonly stream: "stdout" | "stderr" };

const signals = ["SIGINT", "SIGTERM"] as const;
const methods = [
  ["log", "stdout"],
  ["info", "stdout"],
  ["warn", "stderr"],
  ["error", "stderr"],
] as const;

/**
 * Sends what `console.log`, `console.info`, `console.warn`, and
 * `console.error` print to `onLine` instead of the terminal, as the console
 * formats it, until the returned function restores them.
 */
export function captureConsole(onLine: (line: LogLine) => void): () => void {
  const originals = methods.map(([method]) => [method, console[method]] as const);
  for (const [method, stream] of methods) {
    console[method] = (...args: unknown[]) => onLine({ text: format(...args), stream });
  }
  return () => {
    for (const [method, original] of originals) console[method] = original;
  };
}

/**
 * Reads the runs of an evaluation for {@link Watch}. The view waits until
 * `onRun` names a run, then shows the run that `onRun` named last.
 */
export function followRuns(folders: Omit<RunFolders, "runId">): {
  readonly read: (selection: Selection) => Promise<Frame>;
  readonly onRun: (runId: string) => void;
} {
  let runId: string | undefined;
  const read = readRunFolders({ ...folders, runId: () => runId });
  return {
    read: (selection) =>
      runId === undefined
        ? Promise.resolve({ kind: "waiting", message: "Starting the run…" })
        : read(selection),
    onRun: (id) => {
      runId = id;
    },
  };
}

/**
 * Calls `evaluate` and shows its runs full screen until it settles, then
 * prints what it printed. `evaluate` passes the ID of each run to `onRun`
 * once the run's folder holds `run.json`.
 */
export async function evaluateFullScreen<T>(
  folders: Omit<RunFolders, "runId">,
  evaluate: (onRun: (runId: string) => void) => Promise<T>,
): Promise<T> {
  const lines: LogLine[] = [];
  const { read, onRun } = followRuns(folders);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    consoleMode: "disabled",
    openConsoleOnError: false,
    useMouse: false,
    backgroundColor: palette.background,
  });
  const restoreConsole = captureConsole((line) => lines.push(line));

  let flushed = false;
  const flush = () => {
    if (flushed) return;
    flushed = true;
    restoreConsole();
    process.off("exit", flush).off("uncaughtException", crash).off("unhandledRejection", crash);
    for (const signal of signals) process.off(signal, onSignal);
    for (const { text, stream } of lines) process[stream].write(`${text}\n`);
  };
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      renderer.destroy();
      await renderer.closed.catch(() => {});
      flush();
    })());
  const crash = (error: unknown) => {
    if (renderer.isDestroyed) console.error(error);
    void close();
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (process.listenerCount(signal) > 1) return;
    void close().then(() => process.kill(process.pid, signal));
  };
  process.once("exit", flush).on("uncaughtException", crash).on("unhandledRejection", crash);
  for (const signal of signals) process.prependListener(signal, onSignal);
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") process.kill(process.pid, "SIGINT");
  });

  createRoot(renderer).render(
    <Watch
      read={read}
      wallTime={() => new Date()}
      log={() => lines.flatMap((line) => line.text.split("\n"))}
    />,
  );
  try {
    return await evaluate(onRun);
  } finally {
    await close();
  }
}
