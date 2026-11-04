#!/usr/bin/env bash
#
# Fails unless the current branch adds a changeset since a base ref.
#
# Usage: scripts/check-changeset.sh [base-ref]
#
# base-ref defaults to origin/main. CI passes the pull request's base branch.
# Run `git fetch origin` before a local check so the base is current.
#
# Every pull request adds at least one .changeset/*.md file, including pull
# requests that touch no package. Write one with `pnpm changeset`, or with
# `pnpm changeset --empty` when the change needs no release note. See
# .changeset/README.md.

set -euo pipefail

base=${1:-origin/main}
cd "$(git rev-parse --show-toplevel)"

added=$(git diff --name-only --diff-filter=A "$base...HEAD" -- '.changeset/*.md')

if [ -z "$added" ]; then
  echo "::error title=Missing changeset::Run pnpm changeset, or pnpm changeset --empty if this change needs no release note."
  exit 1
fi

pnpm changeset status --since="$base"
