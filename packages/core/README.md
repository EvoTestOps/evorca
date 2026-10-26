# @evorca/core

Shared domain vocabulary for evorca: the types every other package uses to describe an investigation.

## Scope

- Domain types for incidents, signals (logs, metrics, traces, deploys and other changes), hypotheses, and evidence.
- Pure functions over those types.

## Non-goals

- I/O of any kind: no network, filesystem, or process access. Integrations with telemetry backends, model providers, and storage live in their own packages.
- Agent orchestration and prompting.

## Public API

Everything exported from `src/index.ts`. Empty until the first domain types land.
