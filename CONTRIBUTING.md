# Contributing to evorca

Thanks for your interest in contributing to evorca! evorca is developed in public, and we welcome bug reports, feature requests, questions, and research feedback.

## Start with a Discussion

[Open a Discussion](https://github.com/EvoTestOps/evorca/discussions/new/choose) for questions, bug reports, feature requests, and ideas. Search existing Discussions before creating a new one, and include enough detail for someone else to understand and reproduce the problem.

GitHub Issues track work that maintainers have accepted. A maintainer may create an Issue from a Discussion when the scope is clear and the work fits the roadmap.

### Never share production data

evorca works on production telemetry. Do not post real logs, traces, metrics, incident timelines, hostnames, IP addresses, customer data, API keys, or tokens in Discussions, Issues, or pull requests. Reduce a report to a synthetic or scrubbed reproduction.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of posting publicly.

## Pull Requests

For anything beyond a small fix, agree on the approach in a Discussion or Issue before opening a pull request. Contributions written with coding agents are welcome, but you are responsible for your code and must understand how it interacts with the rest of the project.

1. Keep the change focused on one problem.
2. Follow the existing conventions.
3. Add or update tests for behavioral changes.
4. Add a changeset with `pnpm changeset` describing the user-visible change, or `pnpm changeset --empty` if the change needs no release note. See [`.changeset/README.md`](.changeset/README.md).
5. Run `pnpm check` locally and describe the validation in the pull request.
6. Avoid unrelated refactors or dependency changes.

Maintainers may close a pull request that changes scope, cannot be validated safely, or no longer fits the project roadmap.
