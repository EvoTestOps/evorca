---
"@evorca/cli": patch
---

`evorca watch` exits with code 1 and lists the newest runs when it is given a run ID that no run has, instead of waiting for it. On a small terminal the view drops the footer, the keys, and the dots instead of drawing one line over another, and it shows no cost for a run whose agent calls no model.
