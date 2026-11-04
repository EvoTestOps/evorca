<h3 align="center">evorca</h3>

<p align="center">A self-improving agent for autonomous incident investigation and root cause analysis.</p>

<p align="center">
  <a href="https://github.com/EvoTestOps/evorca/actions/workflows/ci.yml">
    <img src="https://github.com/EvoTestOps/evorca/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" />
  </a>
</p>

evorca aims to investigate production incidents on its own and find their root causes. Given an incident, it will gather evidence from the systems you already run (logs, metrics, traces, deploys, and code changes), form root-cause hypotheses and test them against that evidence, and report the most likely cause together with the observations that support it. It only reads from those systems; any remediation is left to a human. Over time, it learns from the outcomes of past investigations, so each one makes the next faster and more accurate.

## Development

You need Node 22.12 or later. `.nvmrc` pins Node 22. `corepack enable` provides the pnpm version that `package.json` pins. From the repository root, run:

```sh
corepack enable
pnpm install
pnpm check
```

`pnpm check` runs the same format check, type check, tests, and build as CI. `pnpm format` fixes formatting.

| Package                                         | Purpose                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| [`@evorca/core`](packages/core/README.md)       | The domain types that every other package shares.                                 |
| [`@evorca/openrca`](packages/openrca/README.md) | Connects evorca to the [OpenRCA](https://github.com/microsoft/OpenRCA) benchmark. |

## Contributing

Open an [Issue](https://github.com/EvoTestOps/evorca/issues) to start a conversation, and read [CONTRIBUTING.md](CONTRIBUTING.md) before working on code. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 EvoTestOps.
