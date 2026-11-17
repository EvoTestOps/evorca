/**
 * The `evorca` command. It opens the interactive shell full screen, and exits
 * with code 1 when stdin or stdout is not a terminal.
 *
 * @module
 */
import { homedir } from "node:os";
import { sep } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createElement } from "react";
import { Shell } from "./shell.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("evorca needs an interactive terminal.\n");
  process.exit(1);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: false });
createRoot(renderer).render(
  createElement(Shell, { directory: tildify(process.cwd()), onExit: () => renderer.destroy() }),
);

function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
