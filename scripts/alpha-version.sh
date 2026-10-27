#!/usr/bin/env bash
# Usage: alpha-version.sh BASE_VERSION BRANCH SHORT_SHA
#
# Prints the alpha release's version and npm dist-tag as GitHub step outputs:
#   version=<BASE_VERSION>-alpha.br-<branch slug>.sha-<SHORT_SHA>
#   tag=alpha-<branch slug>
# The slug is the branch in lower case, each run of other characters than
# letters and digits made one hyphen; "unnamed" when nothing is left.
set -euo pipefail

BASE=$1
BRANCH=$2
SHORT_SHA=$3

SLUG=$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
SLUG=${SLUG:-unnamed}
# Semver forbids an empty identifier and a numeric one with a leading zero
# (a branch "0123", a short SHA "0123456"); a letter prefix rules out both.
printf 'version=%s\n' "${BASE}-alpha.br-${SLUG}.sha-${SHORT_SHA}"
printf 'tag=%s\n' "alpha-${SLUG}"
