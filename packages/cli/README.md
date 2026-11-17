# @evorca/cli

The `evorca` command. From the repository root, `pnpm evorca` runs it without a build or a publish step.

## Scope

- An interactive shell in the terminal, built with [OpenTUI](https://github.com/anomalyco/opentui), which `evorca` opens when it runs without arguments. It opens on a home screen with the evorca wordmark and an input box, then shows a transcript of the session above the input box. A footer shows the working directory and the version.
- The slash commands `/help` and `/exit`.
- `evorca fetch`, which downloads the answer keys and the telemetry of a benchmark's scenarios into `data/benchmarks/<benchmark>/<scenario>/` at the repository root.
- `evorca reproduce`, which downloads only the answer keys and checks that evorca reproduces the scores that a benchmark publishes. It keeps the scorer's checkout and environment in `.cache/` at the repository root.
- One benchmark, `openrca`, through [`@evorca/openrca`](../openrca/README.md).

## Non-goals

- An agent. Every message in the shell gets the same reply until one is connected.
- Benchmark logic. Each benchmark package owns its scenarios, its files, how to download them, and how to score them. The command only parses the command line and prints results.
- Configuration, themes, and mouse input.
- Publishing to npm. The package is private, and `pnpm evorca` runs its TypeScript source through tsx.

## Public API

The package exports no modules. Its interface is the command:

```sh
evorca
evorca fetch --benchmark=<benchmark> [--scenario=<scenario>...]
evorca reproduce --benchmark=<benchmark> [--scenario=<scenario>...]
```

- Without arguments, `evorca` opens the [interactive shell](#use-the-shell).
- `--benchmark` is required. The only benchmark is `openrca`.
- `--scenario` names one scenario and can repeat. Without it, the command uses every scenario of the benchmark. The `openrca` scenarios are `bank`, `telecom`, `market-cloudbed-1`, and `market-cloudbed-2`.

`evorca fetch` prints one line for each file that is already present, and two lines for each file that it downloads: one when the download starts and one when it is done. A line has the status, the path, and the size in bytes. A `present` or `fetched` line also has the SHA-256:

```text
present  data/benchmarks/openrca/telecom/query.csv  20356 bytes  sha256 c2726ea18183a05c83dfb22796d20cb7a371ce4db51ce3da3fda3f6e793735b5
fetching  data/benchmarks/openrca/telecom/telemetry/2020_04_11/trace/trace_span.csv  1165827254 bytes
fetched  data/benchmarks/openrca/telecom/telemetry/2020_04_11/trace/trace_span.csv  1165827254 bytes  sha256 4a75e1ac9430d7b19b14f77dd985bef9e3252c46b59c8b2afa5dae9bcda788dd
```

`evorca reproduce` prints the same lines for the answer keys, then a report. It exits with code 1 if a score differs from the published score.

Both commands exit with code 1 and list the valid choices if the command, the benchmark, or a scenario is unknown. They also exit with code 1, and print the reason, if a file on disk does not match its pinned hash, if the missing files need more than the free disk space, or if a download fails. The free-space message gives both sizes in GB.

## Use the shell

You need Node 26.4 or later, because OpenTUI calls its native library through `node:ffi`. Node 26.4 to 26.8 load `node:ffi` only with `--experimental-ffi`, and every Node 26 release prints an `ExperimentalWarning` when `node:ffi` loads. The `evorca` script passes the flag and hides the warning. Only the shell loads OpenTUI, so `evorca fetch` and `evorca reproduce` never load `node:ffi`. From the repository root, run:

```sh
pnpm evorca
```

The shell opens on the home screen. The wordmark is a panel of dots, like an LED display. Its dots switch on one at a time, and every few seconds a few of them dim for a moment. While the input box is empty, its placeholder types out example questions. Type a message and press Enter. After the first message, the transcript replaces the home screen. Each line you send appears in the transcript, followed by the reply. These commands are available:

- `/help` lists the commands.
- `/exit` closes evorca. ctrl+c does the same.

The shell paints the whole screen in grays on a near-black background, so it looks the same in light and dark terminals. When the terminal is narrower than 73 columns, the plain name replaces the wordmark. In the transcript view, nothing moves while the input box holds text, and the shell does no work until you type or resize the terminal. The shell needs an interactive terminal. When stdin or stdout is not one, as in `echo hi | pnpm evorca`, it prints `evorca needs an interactive terminal.` and exits with code 1.

## Fetch a scenario

You need network access to drive.usercontent.google.com. From the repository root, run:

```sh
pnpm evorca fetch --benchmark=openrca --scenario=bank
```

The command writes the answer keys, `query.csv` and `record.csv`, to `data/benchmarks/openrca/bank/` and the telemetry to `data/benchmarks/openrca/bank/telemetry/`. The telemetry of `bank` is 26.40 GB, and the telemetry of all four scenarios is 68.65 GB. A file that is already present and matches its pinned hash stays as it is, so a second run downloads nothing. To fetch all four scenarios, leave out `--scenario`.

## Reproduce the archive scores

OpenRCA publishes the predictions of its RCA-Agent and their scores in `rca/archive/`. `evorca reproduce --benchmark=openrca` scores those predictions with OpenRCA's own evaluator and checks that every score matches. The [`@evorca/openrca` README](../openrca/README.md#reproduce-the-archive-scores) explains the two stages of the check.

You need:

- Node 26.4 or later. `.nvmrc` pins Node 26.
- pnpm, through `npm install -g corepack` and `corepack enable`.
- [uv](https://docs.astral.sh/uv/). uv downloads Python 3.11 and the packages locked in `packages/openrca/evaluator/uv.lock`.
- git.
- Network access to github.com and drive.usercontent.google.com.

From a fresh clone, run:

```sh
pnpm install
pnpm evorca reproduce --benchmark=openrca
```

`evorca reproduce` first downloads the answer keys, `query.csv` and `record.csv`, of each scenario to `data/benchmarks/openrca/`, about 170 KB in all. It reads no telemetry, so it does not need the 68.65 GB that `evorca fetch` downloads. Then it checks out OpenRCA and creates the Python environment in `.cache/openrca/`. A second run skips the work that a previous run finished.

After the lines for the answer keys, `evorca reproduce` prints the pinned inputs and the Node, uv, and Python versions. Then it prints one block per scenario with the matches in each stage, the accuracy per difficulty, and each mismatch. The last block, `All scenarios`, gives the accuracy over the scenarios that the command checked. To check only some scenarios, name each one with `--scenario`. The [`@evorca/openrca` README](../openrca/README.md#reproduce-the-archive-scores) lists the expected result.
