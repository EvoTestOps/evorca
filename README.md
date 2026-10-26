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

evorca is an open-source agent that investigates production incidents on its own and finds their root causes. It gathers evidence from the systems you already run (logs, metrics, traces, deploys, and code changes), forms and tests root-cause hypotheses, and reports what it found together with the evidence behind each claim. It gets better over time by learning from the outcomes of past investigations.

> **Status:** early scaffold. Nothing is installable yet; the repository currently holds the workspace, tooling, and contribution process.

## Design principles

- **Evidence over assertion:** every root-cause claim links to the observations that support it.
- **Read-only by default:** investigations query production systems; they do not change them. Remediation is a separate action that a human approves.
- **Telemetry is data, not instructions:** log lines, alerts, and tickets are untrusted input and never steer the agent.
- **Reversible self-improvement:** updates to prompts, memories, skills, and playbooks are small, evidence-backed, versioned, and can be rolled back.
- **Built for long investigations:** work survives restarts and can run unattended for hours.

## Development

Requirements: Node.js 22.13+ and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```bash
corepack enable
pnpm install
pnpm check
```

| Command          | What it does                                              |
| ---------------- | --------------------------------------------------------- |
| `pnpm check`     | The merge gate: lint, typecheck, test, and build          |
| `pnpm lint`      | ESLint (type-aware) and a Prettier format check           |
| `pnpm lint:fix`  | Apply ESLint fixes and Prettier formatting                |
| `pnpm typecheck` | `tsc --noEmit` in every package                           |
| `pnpm test`      | Vitest in every package                                   |
| `pnpm build`     | Build every package                                       |
| `pnpm changeset` | Record a release note for your change (see `.changeset/`) |

## Repository layout

```
apps/          deployable entry points (CLI, services)
packages/      libraries, named @evorca/<name>
  core/        shared domain vocabulary
.changeset/    pending release notes
```

## Contributing

Contributions start in [GitHub Issues](https://github.com/EvoTestOps/evorca/issues); see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 EvoTestOps.
