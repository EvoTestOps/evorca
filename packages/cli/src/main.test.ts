import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

async function evorca() {
  const args = ["--experimental-ffi", "--disable-warning=ExperimentalWarning", "--import", "tsx"];
  return promisify(execFile)(process.execPath, [...args, "src/main.ts"], { cwd: packageDir }).then(
    ({ stderr }) => ({ code: 0, stderr }),
    (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
  );
}

describe("evorca", () => {
  it("exits with code 1 and only its own message when stdin is not a terminal", async () => {
    const { code, stderr } = await evorca();

    expect(code).toBe(1);
    expect(stderr).toBe("evorca needs an interactive terminal.\n");
  });
});
