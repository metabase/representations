# Metabase Representation Format

Metabase represents user-created content as a tree of YAML files. Each file represents one entity (a collection, card, dashboard, etc.). The format is designed to be **portable** across Metabase instances: numeric database IDs are replaced with human-readable names and entity IDs.

This repository contains the specification and examples for the Metabase Representation Format.

## Contents

- **[core-spec/v1/spec.md](core-spec/v1/spec.md)** — Full specification (v1.0.0) covering entity keys, folder structure, MBQL and native queries, parameters, and all entity types.
- **[core-spec/v1/schemas/](core-spec/v1/schemas/)** — YAML schemas (JSON Schema format) for each entity type.
- **[examples/v1/](examples/v1/)** — Complete examples using the Sample Database.

## Entity Types

| Entity | Description |
|--------|-------------|
| Collection | Folder-like container for organizing content |
| Card | Question, model, or metric — holds an MBQL or native query |
| Dashboard | Grid layout of cards with filter parameters and tabs |
| Segment | Saved filter definition scoped to a table |
| Measure | Saved aggregation definition scoped to a table |
| Snippet | Reusable SQL fragment for native queries |
| Transform | Materializes query or Python script results into a database table |
| TransformTag | Label for categorizing transforms (built-in or custom) |
| TransformJob | Scheduled job that executes tagged transforms |
| PythonLibrary | Shared Python source file available to Python transforms |

## Schema Validation

### CLI

Validate a folder of YAML files against the schemas:

```sh
npx @metabase/representations validate-schema --folder ./my-export
```

Omit `--folder` to validate the current directory.

### Extracting schemas

Copy the bundled schemas (preserving folder structure) into a target directory:

```sh
npx @metabase/representations extract-schema --folder ./schemas
```

Omit `--folder` to extract into the current directory.

### Programmatic

```js
import { validateSchema } from "@metabase/representations";

const { results, passed, failed } = validateSchema({
  folder: "./my-export",
});

for (const result of results) {
  if (result.status === "fail") {
    console.log(result.file, result.errors);
  }
}
```

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.
