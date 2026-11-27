/**
 * The signals that stop `evorca evaluate`. The first SIGINT or SIGTERM asks
 * the run to stop, and the command goes on until the run has stopped. A
 * repeat of that signal ends the process at once, as a signal without a
 * listener does.
 *
 * @module
 */

const signals = ["SIGINT", "SIGTERM"] as const;

/** The stop signals that a command listens for until it calls `release`. */
export type StopSignals = {
  /** The signal that asked for the stop last, or undefined if none came. */
  readonly received: () => NodeJS.Signals | undefined;
  /** Stops listening, so the next signal ends the process. */
  readonly release: () => void;
};

/** Calls `onStop` when SIGINT or SIGTERM first asks the process to stop. */
export function stopOnSignals(onStop: () => void): StopSignals {
  let received: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    received = signal;
    onStop();
  };
  for (const signal of signals) process.once(signal, onSignal);
  return {
    received: () => received,
    release: () => {
      for (const signal of signals) process.off(signal, onSignal);
    },
  };
}
