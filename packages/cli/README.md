# @evorca/cli

The `evorca` command. From the repository root, `pnpm evorca` runs it without a build or a publish step.

## Scope

- An interactive shell in the terminal, built with [OpenTUI](https://github.com/anomalyco/opentui). It shows the evorca banner, the version and the working directory, a transcript of the session, and an input box at the bottom of the screen.
- The slash commands `/help` and `/exit`.

## Non-goals

- An agent. Every message gets the same reply until one is connected.
- Command-line arguments, configuration, themes, and mouse input.
- Publishing to npm. The package is private, and `pnpm evorca` runs its TypeScript source through tsx.

## Usage

You need Node 26.4 or later, because OpenTUI calls its native library through `node:ffi`. Node 26.4 to 26.8 load `node:ffi` only with `--experimental-ffi`, and every Node 26 release prints an `ExperimentalWarning` when `node:ffi` loads. The `evorca` script passes the flag and hides the warning. From the repository root, run:

```sh
pnpm evorca
```

Type a message and press Enter. Each line you send appears in the transcript, followed by the reply. These commands are available:

- `/help` lists the commands.
- `/exit` closes evorca. ctrl+c does the same.

When the terminal is narrower than the banner, the plain name replaces it. The command needs an interactive terminal. When stdin or stdout is not one, as in `echo hi | pnpm evorca`, it prints `evorca needs an interactive terminal.` and exits with code 1.
