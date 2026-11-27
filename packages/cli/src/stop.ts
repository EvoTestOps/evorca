/**
 * The signals that stop `evorca evaluate`. The first SIGINT or SIGTERM asks
 * the run to stop, and the command goes on until the run has stopped. A
 * later one ends the process at once, as a signal without a listener does.
 *
 * A signal within {@link sameRequestMs} of the first is the same request.
 * `pnpm evorca` needs this: ctrl+c sends SIGINT to pnpm and to the command,
 * and pnpm then sends the command a SIGINT of its own.
 *
 * @module
 */

/**
 * How long after the first signal another still counts as the same request.
 * pnpm's copy came up to 0.55 s late on a machine with more busy processes
 * than cores, and a person takes longer to read the notice and press again.
 */
export const sameRequestMs = 1000;

const signals = ["SIGINT", "SIGTERM"] as const;

/** The stop signals that a command listens for until it calls `release`. */
export type StopSignals = {
  /** The signal that asked for the stop, or undefined if none came. */
  readonly received: () => NodeJS.Signals | undefined;
  /** Stops listening, so the next signal ends the process. */
  readonly release: () => void;
};

/** Calls `onStop` when SIGINT or SIGTERM first asks the process to stop. */
export function stopOnSignals(onStop: () => void): StopSignals {
  let first: { readonly signal: NodeJS.Signals; readonly at: number } | undefined;
  const release = () => {
    for (const signal of signals) process.off(signal, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (first === undefined) {
      first = { signal, at: performance.now() };
      onStop();
    } else if (performance.now() - first.at >= sameRequestMs) {
      release();
      process.kill(process.pid, signal);
    }
  };
  for (const signal of signals) process.on(signal, onSignal);
  return { received: () => first?.signal, release };
}
