#!/usr/bin/env bash
# Usage: alpha-version.sh BASE_VERSION BRANCH SHORT_SHA
#
# Prints the alpha release's version and npm dist-tag as GitHub step outputs:
#   version=<BASE_VERSION>-alpha.br-<branch id>.sha-<SHORT_SHA>
#   tag=alpha-<branch id>
# The branch id is a slug of the branch, a hyphen, and the first 7 hex digits
# of the SHA-256 of the branch name as given. The slug lower-cases the branch,
# replaces each run of characters other than a-z and 0-9 with one hyphen,
# trims hyphens from both ends, and keeps at most 64 characters, with no
# trailing hyphen. An empty slug becomes "unnamed". The hash keeps branches
# whose slugs are equal, such as feat/x and Feat_X, on separate dist-tags.
# Exits 1, printing nothing, when BASE_VERSION is not X.Y.Z.
set -euo pipefail

BASE=$1
BRANCH=$2
SHORT_SHA=$3

# BASE comes from the PR's package.json. A line break in it would add lines to
# $GITHUB_OUTPUT, such as tag=latest.
if ! [[ $BASE =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'alpha-version.sh: base version %q is not of the form X.Y.Z\n' "$BASE" >&2
  exit 1
fi

SLUG=$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
SLUG=${SLUG:0:64}
SLUG=${SLUG%-}
SLUG=${SLUG:-unnamed}
if command -v sha256sum >/dev/null; then
  HASH=$(printf '%s' "$BRANCH" | sha256sum)
else
  HASH=$(printf '%s' "$BRANCH" | shasum -a 256)
fi
BRANCH_ID="${SLUG}-${HASH:0:7}"
# Semver forbids an empty identifier and a numeric one with a leading zero
# (a branch "0123", a short SHA "0123456"); a letter prefix rules out both.
printf 'version=%s\n' "${BASE}-alpha.br-${BRANCH_ID}.sha-${SHORT_SHA}"
printf 'tag=%s\n' "alpha-${BRANCH_ID}"
