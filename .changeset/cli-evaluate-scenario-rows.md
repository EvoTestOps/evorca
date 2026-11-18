---
"@evorca/cli": minor
---

`--rows` can repeat, and a value that starts with a scenario, such as `--rows=bank:3,4`, gives the rows of that scenario only. `--rows=0,7,21` still gives the rows of every scenario, and `run.json` keeps its format, so earlier runs resume and report as before.
