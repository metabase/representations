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

## Schema validation

Validate a folder of YAML files against the schemas:

```sh
npx @metabase/representations validate-schema --folder ./my-export
```

Omit `--folder` to validate the current directory. It exits 1 when a file fails, or when the folder has no YAML files. A file with no `serdes/meta`, or an empty file, passes with a warning: Metabase skips it. A file of a model that Metabase imports and no schema here describes, such as `CustomVizPlugin` or `Dimension`, passes and is counted as not checked. A model that Metabase does not import fails.

The validator reads YAML as Metabase does, with a few [known differences](https://github.com/metabase/representations/blob/main/docs/lint.md#how-yaml-is-read).

## Other commands

Copy the bundled `spec.md` to a file (default `./spec.md`):

```sh
npx @metabase/representations extract-spec --file ./spec.md
```

Copy the bundled schemas, with their folder structure, into a folder (default: the current directory):

```sh
npx @metabase/representations extract-schema --folder ./schemas
```

Print 21-character NanoID entity IDs, or v4 UUIDs, one per line:

```sh
npx @metabase/representations generate-entity-id --count 5
npx @metabase/representations generate-uuid --count 5
```

`--count` defaults to 1.

## Programmatic use

```js
import {
  generateEntityId,
  generateUuid,
  validateSchema,
} from "@metabase/representations";

const { results, passed, failed } = validateSchema({ folder: "./my-export" });
for (const result of results) {
  if (result.status === "fail") {
    console.log(result.file, result.errors);
  }
}

const entityId = generateEntityId(); // "LZfXLFzPPR4NNrgjlWDxn"
const uuid = generateUuid(); // "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8"
```
