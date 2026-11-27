---
"@evorca/cli": patch
---

One ctrl+c under `pnpm evorca evaluate` now stops the run cleanly instead of killing it: pnpm passes the ctrl+c on a second time, and the command took that copy for a second ctrl+c. The scrollback after the full-screen view no longer holds the line about FFI being experimental.
