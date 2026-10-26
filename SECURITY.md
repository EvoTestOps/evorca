# Security policy

evorca runs with access to production telemetry and, through approved actions, to production systems. We take reports about it seriously.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/EvoTestOps/evorca/security/advisories/new) (the repository's **Security** tab, then **Report a vulnerability**). Do not open a public Discussion, Issue, or pull request.

Include the affected commit, a description of the impact, and steps to reproduce using synthetic data. Never include real credentials or production data.

We will acknowledge your report, keep you updated while we investigate, and credit you in the advisory unless you prefer otherwise.

## What we especially want to hear about

- Prompt injection through telemetry: content in logs, traces, alerts, or tickets that makes the agent take an action or disclose data.
- Escaping the read-only boundary: any path where an investigation changes a production system without human approval.
- Credential exposure in prompts, logs, traces, snapshots, or reports.
- Self-improvement updates that widen the agent's permissions or persist attacker-controlled instructions.

## Supported versions

evorca has not had a release yet. Until 1.0, only the latest commit on `main` receives security fixes.
