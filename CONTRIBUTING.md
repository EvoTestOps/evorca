# Contributing to evorca

Thanks for your interest in contributing to evorca! evorca is developed in public, and we welcome bug reports, feature requests, questions, and research feedback. To keep the project maintainable, public contributions begin in [GitHub Discussions](https://github.com/EvoTestOps/evorca/discussions).

With the influx of agent-generated contributions, we do not review unsolicited pull requests or use public Issues as the initial intake queue. While we are open to contributions by agents, you are responsible for your code and must understand how it interacts with the entire project.

## Start with a Discussion

Choose the category that best matches what you want to share:

- [General discussion or question](https://github.com/EvoTestOps/evorca/discussions/categories/general)
- [Bug report](https://github.com/EvoTestOps/evorca/discussions/categories/bug-reports)
- [Feature request](https://github.com/EvoTestOps/evorca/discussions/categories/feature-requests)

Search existing Discussions before creating a new one. Include enough detail for someone else to understand and reproduce the problem, but never share production data: no real logs, traces, metrics, incident timelines, hostnames, customer data, API keys, or tokens. Reduce the report to a synthetic or scrubbed reproduction.

For security vulnerabilities, report them privately as described in [SECURITY.md](SECURITY.md) instead of posting publicly.

## Issues

GitHub Issues track work that maintainers have accepted and intend to investigate or implement. A maintainer may create an Issue from a Discussion when the scope is clear and the work fits the roadmap. An existing Issue does not automatically mean that an external pull request is wanted. Wait for a maintainer to invite implementation before starting substantial work.

Issues that skip the Discussion step may be closed and redirected to Discussions.

## Pull Requests

evorca connects to production systems with an operator's credentials, and its findings inform incident response. We therefore review pull requests only for work a maintainer has invited. If you are interested in contributing code, begin with a Discussion and work with the maintainers on the problem first. Unsolicited pull requests may be closed without review.

## Preparing an Approved Pull Request

If a maintainer has invited a pull request:

1. Keep the change focused on the accepted Issue or Discussion.
2. Follow the repository's existing conventions.
3. Add or update tests for behavioral changes.
4. Add a changeset with `pnpm changeset`, or `pnpm changeset --empty` if the change needs no release note. See [`.changeset/README.md`](.changeset/README.md).
5. Run `pnpm check` locally and describe the validation in the pull request.
6. Avoid unrelated refactors or dependency changes.

Setup and commands are documented in the [README](README.md); `pnpm check` runs the same lint, typecheck, test, and build gates as CI.

Maintainers may close a pull request that changes scope, cannot be validated safely, or no longer fits the project roadmap.
