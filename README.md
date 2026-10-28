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
| Action | A parameterized native SQL write in a collection; implicit row actions on a model are deprecated |
| Dashboard | Grid layout of cards with filter parameters and tabs |
| Segment | Saved filter definition scoped to a table |
| Measure | Saved aggregation definition scoped to a table |
| Snippet | Reusable SQL fragment for native queries |
| Transform | Materializes query or Python script results into a database table |
| TransformTag | Label for categorizing transforms (built-in or custom) |
| TransformJob | Scheduled job that executes tagged transforms |
| TransformTest | Test data for a transform's input tables and checks on its output |
| PythonLibrary | Shared Python source file available to Python transforms |

## Schema Validation

### CLI

Validate a folder of YAML files against the schemas:

```sh
npx @metabase/representations validate-schema --folder ./my-export
```

Omit `--folder` to validate the current directory.

The validator reads each file as Metabase does: YAML 1.1 with SnakeYAML's rules, so `NO` is `false` and `017` is 15. It refuses what SnakeYAML refuses, such as an unknown tag, more than 50 aliases to a map or list, and a document longer than 3,145,728 code points. A duplicate key is an error, although Metabase keeps the last value. A key that SnakeYAML reads as no string, such as a plain `1:` or `yes:`, stays under its text as written.

Known differences from Metabase's reading:

- An integer beyond 2^53 loses precision, where Metabase reads a `Long` or `BigInteger`. Two such keys that differ only past 2^53 are a duplicate key in the validator and two keys in Metabase.
- An explicit tag on a value outside its type's plain form, such as `!!float 1` or `!!bool y`, is refused; Metabase reads `1.0` and `null`.
- `!!binary`, `!!set`, `!!omap` and `!!pairs` read as JavaScript's `Uint8Array`, `Set`, `Map` and a list of one-key maps.
- Nesting deeper than about 6,000 levels is refused for lack of stack. Metabase's limit is 10,000 levels, or less when its thread's stack runs out first.

### Extracting the spec

Copy the bundled `spec.md` to a target file:

```sh
npx @metabase/representations extract-spec --file ./spec.md
```

Omit `--file` to write `spec.md` into the current directory.

### Extracting schemas

Copy the bundled schemas (preserving folder structure) into a target directory:

```sh
npx @metabase/representations extract-schema --folder ./schemas
```

Omit `--folder` to extract into the current directory.

### Generating entity IDs

Print one or more 21-character NanoID entity IDs (one per line):

```sh
npx @metabase/representations generate-entity-id
npx @metabase/representations generate-entity-id --count 5
```

### Generating UUIDs

Print one or more v4 UUIDs (one per line):

```sh
npx @metabase/representations generate-uuid
npx @metabase/representations generate-uuid --count 5
```

### Programmatic

```js
import {
  generateEntityId,
  generateUuid,
  validateSchema,
} from "@metabase/representations";

const { results, passed, failed } = validateSchema({
  folder: "./my-export",
});

for (const result of results) {
  if (result.status === "fail") {
    console.log(result.file, result.errors);
  }
}

const entityId = generateEntityId(); // "LZfXLFzPPR4NNrgjlWDxn"
const uuid = generateUuid(); // "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8"
```

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.
