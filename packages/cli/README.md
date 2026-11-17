# @evorca/cli

The `evorca` command. From the repository root, `pnpm evorca` runs it without a build or a publish step.

## Scope

- `evorca fetch`, which downloads the data of a benchmark's scenarios into `data/benchmarks/<benchmark>/<scenario>/` at the repository root.
- `evorca reproduce`, which checks that evorca reproduces the scores that a benchmark publishes. It keeps the scorer's checkout and environment in `.cache/` at the repository root.
- One benchmark, `openrca`, through [`@evorca/openrca`](../openrca/README.md).

## Non-goals

- Benchmark logic. Each benchmark package owns its scenarios, its files, how to download them, and how to score them. The command only parses the command line and prints results.
- Publishing to npm. The package is private, and `pnpm evorca` runs its TypeScript source through tsx.

## Public API

The package exports no modules. Its interface is the command:

```sh
evorca fetch --benchmark=<benchmark> [--scenario=<scenario>...]
evorca reproduce --benchmark=<benchmark> [--scenario=<scenario>...]
```

- `--benchmark` is required. The only benchmark is `openrca`.
- `--scenario` names one scenario and can repeat. Without it, the command uses every scenario of the benchmark. The `openrca` scenarios are `bank`, `telecom`, `market-cloudbed-1`, and `market-cloudbed-2`.

`evorca fetch` prints one line per file: `fetched` or `present`, the path, the size in bytes, and the SHA-256. `evorca reproduce` prints a report and exits with code 1 if a score differs from the published score. Both commands exit with code 1 and list the valid choices if the command, the benchmark, or a scenario is unknown.

## Fetch a scenario

You need network access to drive.usercontent.google.com. From the repository root, run:

```sh
pnpm evorca fetch --benchmark=openrca --scenario=bank
```

The command writes `data/benchmarks/openrca/bank/query.csv` and `data/benchmarks/openrca/bank/record.csv`. A file that is already present and matches its pinned hash stays as it is, so a second run downloads nothing. To fetch all four scenarios, leave out `--scenario`.

## Reproduce the archive scores

OpenRCA publishes the predictions of its RCA-Agent and their scores in `rca/archive/`. `evorca reproduce --benchmark=openrca` scores those predictions with OpenRCA's own evaluator and checks that every score matches. The [`@evorca/openrca` README](../openrca/README.md#reproduce-the-archive-scores) explains the two stages of the check.

You need:

- Node 22.12 or later. `.nvmrc` pins Node 22.
- pnpm, through `corepack enable`.
- [uv](https://docs.astral.sh/uv/). uv downloads Python 3.11 and the packages locked in `packages/openrca/evaluator/uv.lock`.
- git.
- Network access to github.com and drive.usercontent.google.com.

From a fresh clone, run:

```sh
pnpm install
pnpm evorca fetch --benchmark=openrca
pnpm evorca reproduce --benchmark=openrca
```

`evorca fetch` writes to `data/benchmarks/openrca/`. `evorca reproduce` checks out OpenRCA and creates the Python environment in `.cache/openrca/`. Both commands skip work that a previous run finished.

`evorca reproduce` prints the pinned inputs and the Node, uv, and Python versions first. Then it prints one block per scenario with the matches in each stage, the accuracy per difficulty, and each mismatch. The last block, `All scenarios`, gives the accuracy over the scenarios that the command checked. To check only some scenarios, name each one with `--scenario`. The [`@evorca/openrca` README](../openrca/README.md#reproduce-the-archive-scores) lists the expected result.
