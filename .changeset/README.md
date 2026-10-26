# Changesets

Release notes for evorca are recorded here as changesets: small Markdown files that each describe one change. At release time, `pnpm version-packages` applies them: it bumps package versions, writes each package's `CHANGELOG.md`, and deletes the consumed changesets.

## Adding a changeset

Run `pnpm changeset` on your branch, select the packages your change affects, pick a bump type, and write the summary. Commit the generated file with your change.

- `patch` for fixes, `minor` for new behavior, `major` for breaking changes. Before 1.0, breaking changes are `minor`.
- Write the summary for someone using the package: one or two present-tense sentences about the visible behavior, not the implementation.
  - Good: "Hypotheses with no supporting evidence are no longer reported as root causes."
  - Bad: "Refactor ranking.ts."
- A change that needs no release note (refactor, tests, tooling) can use `pnpm changeset --empty`.

See the [Changesets documentation](https://github.com/changesets/changesets) for details.
