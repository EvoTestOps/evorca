# @evorca/core

Shared domain vocabulary for evorca. It holds the types that every other package uses to describe an investigation.

## Scope

- Domain types for incidents, signals (logs, metrics, traces, deploys and other changes), hypotheses, and evidence.
- Pure functions over those types.

## Non-goals

- I/O of any kind, such as network, filesystem, or process access. Integrations with telemetry backends, model providers, and storage live in their own packages.
- Agent orchestration and prompting.

## Public API

Everything exported from `src/index.ts`:

- `Diagnosis` is the array of `RootCause` values that an investigation reports for one incident. An empty array reports none.
- `RootCause` describes one root cause with an optional `occurredAt`, `component`, and `reason`. Every field is optional, because a task can ask for any subset of them.
- `UnixSeconds` is a `number` of seconds since the Unix epoch. Its brand stops a plain `number`, such as a time in milliseconds, from passing for one.
