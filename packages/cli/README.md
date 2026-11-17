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

The command prints one line for each file that is already present, and two lines for each file that it downloads: one when the download starts and one when it is done. A line has the status, the path, and the size in bytes. A `present` or `fetched` line also has the SHA-256:

```text
present  data/benchmarks/openrca/telecom/query.csv  20356 bytes  sha256 c2726ea18183a05c83dfb22796d20cb7a371ce4db51ce3da3fda3f6e793735b5
fetching  data/benchmarks/openrca/telecom/telemetry/2020_04_11/trace/trace_span.csv  1165827254 bytes
fetched  data/benchmarks/openrca/telecom/telemetry/2020_04_11/trace/trace_span.csv  1165827254 bytes  sha256 4a75e1ac9430d7b19b14f77dd985bef9e3252c46b59c8b2afa5dae9bcda788dd
```

The command exits with code 1 and lists the valid choices if the command, the benchmark, or a scenario is unknown. It also exits with code 1, and prints the reason, if a file on disk does not match its pinned hash, if the missing files need more than the free disk space, or if a download fails. The free-space message gives both sizes in GB.

## Fetch a scenario

You need network access to drive.usercontent.google.com. From the repository root, run:

```sh
pnpm evorca fetch --benchmark=openrca --scenario=bank
```

The command writes the answer keys, `query.csv` and `record.csv`, to `data/benchmarks/openrca/bank/` and the telemetry to `data/benchmarks/openrca/bank/telemetry/`. The telemetry of `bank` is 26.40 GB, and the telemetry of all four scenarios is 68.65 GB. A file that is already present and matches its pinned hash stays as it is, so a second run downloads nothing. To fetch all four scenarios, leave out `--scenario`.
