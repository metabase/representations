# Contributing

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.
