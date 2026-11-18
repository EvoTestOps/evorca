---
"@evorca/cli": minor
---

`evorca evaluate --runs=N` makes N complete runs with the same settings and consecutive seeds, then prints the mean, the sample standard deviation, the minimum, and the maximum of each accuracy, with each run's cost and wall time. Resuming any run of a stopped series finishes the series without running a finished task again. `evorca report` prints the same summary from the run folders. A run that ctrl+c stops records its running tasks as `stopped` with what they spent, so `run.json` matches the request logs at once.
