# @evorca/cli

The `evorca` command. From the repository root, `pnpm evorca` runs it without a build or a publish step.

## Scope

- `evorca fetch`, which downloads the data of a benchmark's scenarios into `data/benchmarks/<benchmark>/<scenario>/` at the repository root.
- One benchmark, `openrca`, through [`@evorca/openrca`](../openrca/README.md).

## Non-goals

- Benchmark logic. Each benchmark package owns its scenarios, its files, and how to download them. The command only parses the command line and prints results.
- Publishing to npm. The package is private, and `pnpm evorca` runs its TypeScript source through tsx.

## Public API

The package exports no modules. Its interface is the command:

```sh
evorca fetch --benchmark=<benchmark> [--scenario=<scenario>...]
```

- `--benchmark` is required. The only benchmark is `openrca`.
- `--scenario` names one scenario and can repeat. Without it, the command fetches every scenario of the benchmark. The `openrca` scenarios are `bank`, `telecom`, `market-cloudbed-1`, and `market-cloudbed-2`.

The command prints one line per file: `fetched` or `present`, the path, the size in bytes, and the SHA-256. It exits with code 1 and lists the valid choices if the command, the benchmark, or a scenario is unknown.

## Fetch a scenario

You need network access to drive.usercontent.google.com. From the repository root, run:

```sh
pnpm evorca fetch --benchmark=openrca --scenario=bank
```

The command writes `data/benchmarks/openrca/bank/query.csv` and `data/benchmarks/openrca/bank/record.csv`. A file that is already present and matches its pinned hash stays as it is, so a second run downloads nothing. To fetch all four scenarios, leave out `--scenario`.
