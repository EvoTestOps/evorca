---
"@evorca/cli": minor
"@evorca/openrca": minor
---

`pnpm evorca reproduce --benchmark=openrca` replaces `pnpm --filter @evorca/openrca reproduce-archive` and checks only the scenarios named with `--scenario`, if any. `@evorca/openrca/scoring` exports `reproduceArchive`, `evaluatorVersions`, and `pinnedInputs`.
