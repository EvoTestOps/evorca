# OpenRCA telecom results

Each folder here holds the `run.json`, `predictions.csv`, and `scores.json` of one finished `evorca evaluate` run on the `telecom` scenario, copied from `data/runs/openrca/telecom/` without changes. The [`@evorca/cli` README](../../../packages/cli/README.md#read-a-run) describes the three files.

## `react` with `claude-sonnet-5` at effort `high`

Six runs of the [`react`](../../../agents/react/README.md) agent on all 51 tasks, at evorca commit `bc31df9`, with the image `evorca-agent-react:05c0a85526c3`. The agent sees the candidates. Runs 1 to 5 are one `--runs=5` series of 2026-11-18. The sixth run is from 2026-11-27.

| Accuracy (%)   | Tasks |  Mean |   SD |   Min |   Max |
| -------------- | ----: | ----: | ---: | ----: | ----: |
| easy strict    |    24 | 50.69 | 5.54 | 41.67 | 58.33 |
| easy partial   |    24 | 50.69 | 5.54 | 41.67 | 58.33 |
| middle strict  |    18 | 35.19 | 5.74 | 27.78 | 44.44 |
| middle partial |    18 | 57.87 | 5.10 | 52.78 | 66.67 |
| hard strict    |     9 | 37.04 | 5.74 | 33.33 | 44.44 |
| hard partial   |     9 | 70.48 | 5.75 | 63.11 | 77.89 |
| total strict   |    51 | 42.81 | 2.89 | 37.25 | 45.10 |
| total partial  |    51 | 56.72 | 1.65 | 54.92 | 59.18 |

| Run                      |       Seed | Strict (%) | Partial (%) | Requests | Cost (USD) | Wall time |
| ------------------------ | ---------: | ---------: | ----------: | -------: | ---------: | --------: |
| 20261118T094052Z-react-1 |   53588425 |      45.10 |       57.22 |     1409 |    22.6147 |   1:14:57 |
| 20261118T094052Z-react-2 |   53588426 |      45.10 |       59.18 |     1452 |    22.6155 |   1:14:46 |
| 20261118T094052Z-react-3 |   53588427 |      43.14 |       57.86 |     1571 |    24.9303 |   1:27:05 |
| 20261118T094052Z-react-4 |   53588428 |      43.14 |       55.88 |     1446 |    23.8080 |   1:19:31 |
| 20261118T094052Z-react-5 |   53588429 |      37.25 |       54.92 |     1417 |    21.3220 |   1:13:07 |
| 20261127T062559Z-react   | 3382786902 |      43.14 |       55.25 |     1518 |    23.8407 |   1:20:12 |
| Mean                     |            |            |             |   1468.8 |    23.1885 |   1:18:16 |
| Total                    |            |            |             |     8813 |   139.1311 |   7:49:38 |

The tables are the output of `evorca report`. Do not edit them by hand.

For comparison, RCA-Agent with Claude 3.5 Sonnet scores 23.53% strict and 28.08% partial on the same 51 tasks, as [`evorca reproduce`](../../../packages/openrca/README.md#reproduce-the-archive-scores) checks. The model and the agent loop both differ from RCA-Agent's, and these runs do not separate the two effects.

## Print the tables again

`evorca report` reads runs from `data/runs/`, which git ignores. From the repository root, copy the runs there, then name them:

```sh
mkdir -p data/runs/openrca
cp -Rn results/openrca/. data/runs/openrca/
pnpm evorca report --benchmark=openrca --scenario=telecom \
  20261118T094052Z-react-1 20261118T094052Z-react-2 20261118T094052Z-react-3 \
  20261118T094052Z-react-4 20261118T094052Z-react-5 20261127T062559Z-react
```

The command needs Node 26.4 or later and `pnpm install`. It calls no model and no scorer.

## Make the runs again

A new run costs about $23 and takes about 80 minutes. Follow [Evaluate an agent that calls a model](../../../packages/cli/README.md#evaluate-an-agent-that-calls-a-model), then run:

```sh
git checkout bc31df921bd92beb0f0a0fed627ef1bed01ffbe3
pnpm evorca evaluate --benchmark=openrca --scenario=telecom --agent=react --runs=5
```

The first line of output must name the image `evorca-agent-react:05c0a85526c3`. Another tag means that `agents/react/` differs from these runs.

The model takes no seed, so new runs give new samples. Expect a mean strict accuracy within about 3 points of 42.81%, the standard deviation of the six runs.

## Trajectories

The folders here leave out `tasks/`, which holds each task's trajectory, summary, container log, and request log, about 13 MB for a run. The `tasks/` folders of the six runs are in one archive that is not published yet:

```text
openrca-telecom-react-claude-sonnet-5-6runs.tar.gz
19374249 bytes
sha256 95f1ec87d777be6082503d9632674144ceb114925774fcf13310ee8c4f2d27b3
```

The archive holds the six run folders in full, so it also holds the files here.

## Limits

- Telecom is one of four scenarios, and the one where RCA-Agent scores highest.
- Tasks that share a failure window ask about the same failure. The 51 tasks are not independent, so the spread over runs understates the uncertainty.
- `claude-sonnet-5` is an alias. If the model behind it changes, a new run measures another model.
- Each `run.json` records the checkout as `dirty`. For the run of 2026-11-27, the only uncommitted change was an untracked folder outside the packages.
