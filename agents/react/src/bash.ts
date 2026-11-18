/**
 * The bash session behind the `bash` tool. One bash process runs the model's
 * commands one at a time, so the working directory, variables, and functions
 * persist between calls.
 *
 * Each command runs through `eval` with stdin from `/dev/null`, so a syntax
 * error or a command that reads stdin cannot swallow what follows. After the
 * command, bash prints a marker with a random nonce and the exit status, and
 * the output ends where the marker starts. stderr goes to stdout, in order.
 *
 * A command that runs past the timeout kills the session's whole process
 * group, and so does a restart. The next command then starts a new session.
 * Output longer than the limit keeps its start and its end around a note.
 *
 * @module
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Where the session runs and its limits. */
export type BashOptions = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly outputChars: number;
};

/**
 * How a command ended: it finished with an exit status, it ran past the
 * timeout, or the shell itself exited, as after `exit`.
 */
export type CommandEnd =
  | { readonly kind: "finished"; readonly exitCode: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "session-exit"; readonly code: number | null };

/** What a command printed, cut to the output limit, and how it ended. */
export type CommandResult = { readonly output: string; readonly end: CommandEnd };

/** A persistent bash session. It starts a shell on the first command. */
export class BashSession {
  readonly #options: BashOptions;
  #shell: Shell | undefined;

  constructor(options: BashOptions) {
    this.#options = options;
  }

  /** Runs `command` in the session and returns its output and how it ended. */
  async run(command: string): Promise<CommandResult> {
    this.#shell ??= new Shell(this.#options);
    const result = await this.#shell.run(command);
    if (result.end.kind !== "finished") this.restart();
    return result;
  }

  /** Ends the session. The next command starts a new one. */
  restart(): void {
    this.#shell?.kill();
    this.#shell = undefined;
  }
}

class Shell {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: BashOptions;
  readonly #endMarker: string;

  constructor(options: BashOptions) {
    this.#options = options;
    this.#endMarker = `\n__evorca_${randomBytes(12).toString("hex")}__ `;
    this.#child = spawn("bash", ["--noprofile", "--norc"], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
    });
    this.#child.stdin.on("error", () => {});
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    // A runaway command should be the out-of-memory victim, not the agent.
    this.#child.stdin.write("exec 2>&1\n{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null\n");
  }

  run(command: string): Promise<CommandResult> {
    const capture = new Capture(this.#options.outputChars, this.#endMarker);
    const child = this.#child;
    return new Promise((resolve) => {
      const finish = (end: CommandEnd) => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.off("close", onClose);
        resolve({ output: capture.output(), end });
      };
      const onData = (chunk: string) => {
        const exitCode = capture.push(chunk);
        if (exitCode !== undefined) finish({ kind: "finished", exitCode });
      };
      const onClose = (code: number | null) => finish({ kind: "session-exit", code });
      const timer = setTimeout(() => finish({ kind: "timeout" }), this.#options.timeoutMs);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish({ kind: "session-exit", code: child.exitCode });
        return;
      }
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("close", onClose);
      const quoted = `'${command.replaceAll("'", `'\\''`)}'`;
      const marker = this.#endMarker.slice(1, -1);
      child.stdin.write(`eval ${quoted} < /dev/null\nprintf '\\n%s %d\\n' ${marker} "$?"\n`);
    });
  }

  kill(): void {
    if (this.#child.pid === undefined) return;
    try {
      process.kill(-this.#child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

/**
 * Collects a command's output until the end marker. It never holds more than
 * a few times the output limit: past that it drops the middle, keeping the
 * start, the end, and a count of what it dropped.
 */
class Capture {
  readonly #limit: number;
  readonly #endMarker: string;
  #text = "";
  #dropped = 0;

  constructor(limit: number, endMarker: string) {
    this.#limit = limit;
    this.#endMarker = endMarker;
  }

  /** Adds a chunk of output. Returns the exit status once the marker line is complete. */
  push(chunk: string): number | undefined {
    this.#text += chunk;
    const at = this.#text.indexOf(this.#endMarker);
    if (at >= 0) {
      const newline = this.#text.indexOf("\n", at + this.#endMarker.length);
      if (newline < 0) return undefined;
      const exitCode = Number(this.#text.slice(at + this.#endMarker.length, newline));
      this.#text = this.#text.slice(0, at);
      return exitCode;
    }
    if (this.#text.length > 4 * this.#limit) {
      const half = Math.floor(this.#limit / 2);
      const tail = half + this.#endMarker.length + 16;
      this.#dropped += this.#text.length - half - tail;
      this.#text = this.#text.slice(0, half) + this.#text.slice(-tail);
    }
    return undefined;
  }

  /** The output so far, with its middle replaced by a note if it is longer than the limit. */
  output(): string {
    const total = this.#text.length + this.#dropped;
    if (total <= this.#limit) return this.#text.toWellFormed();
    const half = Math.floor(this.#limit / 2);
    const omitted = total - 2 * half;
    const head = this.#text.slice(0, half);
    const tail = this.#text.slice(-half);
    return `${head}\n\n[... ${omitted} characters omitted ...]\n\n${tail}`.toWellFormed();
  }
}

/**
 * Formats a command's result as the text of its tool result, with a note when
 * the command failed, timed out, or ended the session.
 */
export function describeResult(result: CommandResult, timeoutSeconds: number): string {
  const { output, end } = result;
  const note = (text: string) =>
    `${output}${output === "" || output.endsWith("\n") ? "" : "\n"}[${text}]`;
  switch (end.kind) {
    case "finished":
      if (end.exitCode !== 0) return note(`exit code ${end.exitCode}`);
      return output === "" ? "(no output)" : output;
    case "timeout":
      return note(
        `The command ran longer than ${timeoutSeconds} seconds and was stopped. The bash session restarted: its working directory and variables are lost, but files remain.`,
      );
    case "session-exit":
      return note(
        `The bash session exited with code ${end.code}. The next command starts a new session.`,
      );
  }
}
