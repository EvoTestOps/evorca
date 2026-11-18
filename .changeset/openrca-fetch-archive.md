---
"@evorca/cli": minor
"@evorca/openrca": minor
---

`pnpm evorca fetch` and `pnpm evorca reproduce` take `--archive=<path>`, an OpenRCA dataset archive that you downloaded yourself, and read the files from it instead of from Google Drive. Each file must still match its pinned size and SHA-256. When Google Drive refuses a download because the file's quota is used up, the command names the archive, its link for a browser, and the command to run with `--archive`.
