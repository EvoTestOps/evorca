---
"@evorca/cli": minor
"@evorca/openrca": minor
---

`pnpm evorca fetch` and `pnpm evorca reproduce` take `--archive=<path>`, an OpenRCA dataset archive that you downloaded yourself, and read the files from it instead of from Google Drive. Each file must still match its pinned size and SHA-256.
