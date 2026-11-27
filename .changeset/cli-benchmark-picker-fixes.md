---
"@evorca/cli": patch
---

The `/benchmark` picker shows `Choose a task.` on a line of its own and keeps the last task in view, and its command fits the screen by splitting a long list of rows over several `--rows` values, so a copy of it runs. `evorca evaluate` adds up the `--rows` values for one scenario and exits with code 1 when `--rows` gives a row twice.
