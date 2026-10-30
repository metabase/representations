# Contributing

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.

## Alpha builds

To publish a pull request's head commit for testing, add the `publish-alpha` label to the pull request. The **Publish Alpha from Branch** workflow then:

- publishes version `<version>-alpha.br-<branch id>.sha-<short SHA>` under the dist-tag `alpha-<branch id>`, where `<version>` is the `version` in the branch's `package.json`;
- comments on the pull request with the install command;
- removes the label, so adding it again publishes the branch's new head.

The branch id is a slug of the branch name, a hyphen, and 7 hex digits of the SHA-256 of the branch name. The slug is the name in lower case, with each run of characters other than a-z and 0-9 made one hyphen, hyphens trimmed from both ends, and at most 64 characters. The hash keeps branches such as `feat/x` and `Feat_X` on separate dist-tags. `scripts/alpha-version.sh` computes both.

A commit already published publishes nothing: npm refuses a version twice, and the comment names the existing version. The `latest` dist-tag does not move.

The workflow runs only for pull requests from branches of this repository, not from forks. It builds the branch's code in a job that holds `NPM_RELEASE_TOKEN`, so anyone who can push a branch here can publish under `@metabase`.
