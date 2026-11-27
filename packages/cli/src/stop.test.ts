import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

const command = `
  import { stopOnSignals } from "./src/stop.ts";
  const signals = stopOnSignals(() => {
    console.log("stopping");
    setTimeout(() => {
      signals.release();
      console.log("stopped");
      process.exit(130);
    }, Number(process.env.STOP_TAKES_MS));
  });
  setInterval(() => {}, 1000);
  console.log("ready");
`;

/** Starts a command that takes `stopTakesMs` to stop, and waits until it listens. */
async function start(stopTakesMs: number) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", command], {
    cwd: packageDir,
    env: { ...process.env, STOP_TAKES_MS: String(stopTakesMs) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  onTestFinished(() => void child.kill("SIGKILL"));
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
  const exit = once(child, "close").then(([code, signal]) => ({ code, signal, stdout }));
  while (!stdout.includes("ready")) await once(child.stdout, "data");
  return { child, exit };
}

describe("stopOnSignals", () => {
  it("finishes the stop when one ctrl+c reaches the command twice, as under pnpm", async () => {
    const { child, exit } = await start(300);

    child.kill("SIGINT");
    await sleep(10);
    child.kill("SIGINT");

    expect(await exit).toEqual({ code: 130, signal: null, stdout: "ready\nstopping\nstopped\n" });
  });

  it("stops once when a second ctrl+c under pnpm comes moments after the first", async () => {
    const { child, exit } = await start(600);

    child.kill("SIGINT");
    child.kill("SIGINT");
    await sleep(300);
    child.kill("SIGINT");
    child.kill("SIGTERM");

    expect(await exit).toEqual({ code: 130, signal: null, stdout: "ready\nstopping\nstopped\n" });
  });

  it("ends the process at once on a second ctrl+c", async () => {
    const { child, exit } = await start(60_000);

    child.kill("SIGINT");
    await sleep(1100);
    child.kill("SIGINT");

    expect(await exit).toEqual({ code: null, signal: "SIGINT", stdout: "ready\nstopping\n" });
  });
});
