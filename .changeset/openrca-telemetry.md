---
"@evorca/cli": minor
"@evorca/openrca": minor
---

`evorca fetch` and `fetchOpenRcaData` also download each scenario's telemetry, into `<scenario>/telemetry/`, and check each file against its pinned size and SHA-256. Before any download, they check that the missing files fit in the free disk space. `fetchOpenRcaData` is now an async generator that yields a `FileProgress` when a file is present, when its download starts, and when its download is done.
