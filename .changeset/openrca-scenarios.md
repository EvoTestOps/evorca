---
"@evorca/openrca": minor
---

Names the OpenRCA scenarios by slug, such as `market-cloudbed-1`, and keeps each scenario's files in `<dataDir>/<scenario>/`. `openRcaScenarios` replaces `openRcaSystems`. `readTasks`, `scoreWithOfficialEvaluator`, and `fetchOpenRcaData` take scenarios, and an `OpenRcaTask` has a `scenario` instead of a `system`. `fetchOpenRcaData` is public through `@evorca/openrca/dataset`, and `evorca fetch` replaces the `fetch-data` script.
