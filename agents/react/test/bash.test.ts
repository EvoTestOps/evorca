import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashSession, describeResult, type BashOptions } from "../src/bash.ts";

let cwd: string;
let session: BashSession;

const open = (options: Partial<BashOptions> = {}) =>
  new BashSession({ cwd, env: process.env, timeoutMs: 5_000, outputChars: 1_000, ...options });

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "evorca-bash-"));
  session = open();
});

afterEach(async () => {
  session.restart();
  await rm(cwd, { recursive: true, force: true });
});

describe("BashSession", () => {
  it("returns stdout and stderr in order, with the exit status", async () => {
    const result = await session.run(
      "echo out; echo err >&2; echo out2; exit_code() { return 3; }; exit_code",
    );
    expect(result).toEqual({ output: "out\nerr\nout2\n", end: { kind: "finished", exitCode: 3 } });
  });

  it("keeps the working directory, variables, and functions between commands", async () => {
    await session.run("mkdir -p work && cd work && export COLOR=teal && greet() { echo hi $1; }");
    const result = await session.run('basename "$PWD"; echo "$COLOR"; greet there');
    expect(result.output).toBe("work\nteal\nhi there\n");
  });

  it("keeps output without a final newline as it is", async () => {
    expect((await session.run("printf abc")).output).toBe("abc");
    expect((await session.run("true")).output).toBe("");
  });

  it("survives a syntax error, quotes, and a command that reads stdin", async () => {
    const broken = await session.run("echo 'unterminated");
    expect(broken.end).toEqual({ kind: "finished", exitCode: 2 });
    const quoted = await session.run(`echo "it's" 'a "test"'`);
    expect(quoted.output).toBe(`it's a "test"\n`);
    const stdin = await session.run("cat; echo after");
    expect(stdin.output).toBe("after\n");
    const heredoc = await session.run("python3 - <<'EOF'\nprint(6 * 7)\nEOF");
    expect(heredoc.output).toBe("42\n");
  });

  it("stops a command at the timeout and starts a new session for the next one", async () => {
    session = open({ timeoutMs: 300 });
    await session.run("export MARK=before");
    const started = Date.now();
    const slow = await session.run("echo partial; sleep 30");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(slow).toEqual({ output: "partial\n", end: { kind: "timeout" } });
    const next = await session.run('echo "mark=$MARK"');
    expect(next.output).toBe("mark=\n");
  });

  it("kills the timed-out command's children", async () => {
    session = open({ timeoutMs: 300 });
    await session.run("sleep 30 & echo $! > pid; wait");
    const check = await session.run('kill -0 "$(cat pid)" 2>/dev/null && echo alive || echo gone');
    expect(check.output).toBe("gone\n");
  });

  it("restarts on request and after the shell exits", async () => {
    await session.run("export MARK=before");
    session.restart();
    expect((await session.run('echo "mark=$MARK"')).output).toBe("mark=\n");
    await session.run("export MARK=again");
    expect(await session.run("echo bye; exit 4")).toEqual({
      output: "bye\n",
      end: { kind: "session-exit", code: 4 },
    });
    expect((await session.run('echo "mark=$MARK"')).output).toBe("mark=\n");
  });

  it("keeps the start and the end of long output around a note", async () => {
    const result = await session.run("seq 1 100000");
    const full = `${Array.from({ length: 100_000 }, (_, i) => i + 1).join("\n")}\n`;
    const omitted = full.length - 1_000;
    expect(result.output).toBe(
      `${full.slice(0, 500)}\n\n[... ${omitted} characters omitted ...]\n\n${full.slice(-500)}`,
    );
    expect(result.end).toEqual({ kind: "finished", exitCode: 0 });
  });

  it("keeps output at the limit whole", async () => {
    const result = await session.run("head -c 1000 /dev/zero | tr '\\0' x");
    expect(result.output).toBe("x".repeat(1000));
  });
});

describe("describeResult", () => {
  it.each([
    [{ output: "", end: { kind: "finished", exitCode: 0 } }, "(no output)"],
    [{ output: "ok\n", end: { kind: "finished", exitCode: 0 } }, "ok\n"],
    [{ output: "", end: { kind: "finished", exitCode: 1 } }, "[exit code 1]"],
    [
      { output: "no such file\n", end: { kind: "finished", exitCode: 2 } },
      "no such file\n[exit code 2]",
    ],
    [
      { output: "", end: { kind: "timeout" } },
      "[The command ran longer than 120 seconds and was stopped. The bash session restarted: its working directory and variables are lost, but files remain.]",
    ],
    [
      { output: "bye\n", end: { kind: "session-exit", code: 0 } },
      "bye\n[The bash session exited with code 0. The next command starts a new session.]",
    ],
  ] as const)("describes %j", (result, text) => {
    expect(describeResult(result, 120)).toBe(text);
  });
});
