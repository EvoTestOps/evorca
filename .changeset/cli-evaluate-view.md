---
"@evorca/cli": minor
---

`evorca evaluate` shows the run full screen in a terminal, in the view of `evorca watch`, with the lines that it prints under the feed. When the run ends or stops, the view closes and the command prints those lines, so the scrollback holds the same text as before. `--plain` and output without a terminal print the lines as the run goes, as before.
