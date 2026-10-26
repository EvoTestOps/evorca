## What changed

## Why

## Production safety

- [ ] Investigation paths stay read-only; any action that changes a production system is a separate tool behind human approval
- [ ] Telemetry content is handled as data, never as instructions or unescaped command/query input
- [ ] No real production data, credentials, or customer identifiers in code, fixtures, or this description

## Gates

- [ ] `pnpm check`
- [ ] Changeset added (`pnpm changeset`, or `pnpm changeset --empty` for internal-only changes)

## Test evidence
