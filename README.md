# Metabase Representation Format

Metabase represents user-created content as a tree of YAML files. Each file represents one entity (a collection, card, dashboard, etc.). The format is designed to be **portable** across Metabase instances: numeric database IDs are replaced with human-readable names and entity IDs.

This repository contains the specification and examples for the Metabase Representation Format.

## Contents

- **[core-spec/v1/spec.md](https://github.com/metabase/representations/blob/main/core-spec/v1/spec.md)** — Full specification (v1.0.0) covering entity keys, folder structure, MBQL and native queries, parameters, and all entity types.
- **[core-spec/v1/schemas/](https://github.com/metabase/representations/tree/main/core-spec/v1/schemas)** — YAML schemas (JSON Schema format) for each entity type.
- **[examples/v1/](https://github.com/metabase/representations/tree/main/examples/v1)** — Complete examples using the Sample Database. The transforms run on a Postgres copy of it, `Sample Postgres`.
- **[docs/lint.md](https://github.com/metabase/representations/blob/main/docs/lint.md)** — How the lint resolves tables, reads SQL and YAML, and where it can be wrong.
- **[CONTRIBUTING.md](https://github.com/metabase/representations/blob/main/CONTRIBUTING.md)** — How releases and alpha builds from a pull request are published.

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

Omit `--folder` to validate the current directory. It exits 1 when a file fails, or when the folder has no YAML files. A file with no `serdes/meta`, an empty file, or a file that holds only `[]` or `''` passes with a warning: Metabase skips it. A file of a model that Metabase imports and no schema here describes, such as `CustomVizPlugin` or `Dimension`, passes and is counted as not checked. A model that Metabase does not import fails.

The validator reads YAML as Metabase does, with a few [known differences](https://github.com/metabase/representations/blob/main/docs/lint.md#how-yaml-is-read).

## Lint

The lint is experimental. It is outside the package's semver guarantees: its rules, findings, output and options can change in any release. The `lint` command runs only with `--experimental`, and its programmatic API comes from `@metabase/representations/experimental`.

The lint reads SQL with [Pyodide](https://pyodide.org), an optional peer dependency that a plain install of the package leaves out. Install it, at the version the package pins, where `@metabase/representations` is installed, for the lint to read SQL. A tool that depends on the package installs it among its own dependencies:

```sh
npm install pyodide@314.0.7
```

[The lint in detail](https://github.com/metabase/representations/blob/main/docs/lint.md) explains how it resolves default schemas, reads SQL and YAML, and where it can be wrong.

### Settings file

`.metabase-lint.json` at the root of the linted folder gives each database's default schema and engine, by database name as the files name it. Both keys are optional, and the file must be a regular file, not a symbolic link:

```json
{
  "defaultSchemas": {
    "Warehouse": "public",
    "Legacy": null
  },
  "engines": {
    "Warehouse": "postgres",
    "Legacy": "mysql"
  }
}
```

`null` means the database has no schemas. An engine is Metabase's driver name, such as `postgres`, `snowflake` or `bigquery-cloud-sdk`. A Database file that names an engine takes precedence.

### Lint rules

| Rule | Severity | What it catches |
|------|----------|-----------------|
| `schema` | error | A transform, transform test, table, Database or snippet file that fails its schema, a file that is not a YAML map, a file whose `serdes/meta` names no model or a model outside the models Metabase imports, a symbolic link in a folder Metabase imports, or a transform whose source database was deleted. |
| `invalid-utf8` | warning | A file that is not valid UTF-8. Metabase reads each invalid byte sequence as U+FFFD, and the lint reads the file the same way. |
| `skipped-by-metabase` | warning | A file with no `serdes/meta`, an empty file, or a file that holds only `[]` or `''`, which Metabase skips. |
| `duplicate-yaml-key` | warning | A key written twice in one map of a file. Metabase keeps the last value, or the first in a merge source written after `<<:`, without a message. |
| `duplicate-entity-id` | warning | Two files of one model that hold the same `entity_id`. Remote sync keeps the last in path order (the paths sorted as strings, by UTF-16 code unit) and drops the others without a message. Files of different models may share an `entity_id`. |
| `duplicate-target` | warning | Two transforms that write the same table. On Redshift, which folds every name to lower case, targets that differ only in case are the same table. |
| `transform-cycle` | error | Transforms that read each other's targets. |
| `null-schema-reference` | error | An MBQL reference in a transform or a card with a `null` schema, on a database whose engine has schemas. Metabase imports it as a table with no schema, an inactive stub that holds no data: a query that reads it fails on every run. A `temporal-unit` tag and a `dimension` tag with a default put their field in the query, so their table is read. A card's `dimension` tag with no default on such a table gives this error too: the card fails once the tag has a value. An unknown engine gives no finding, and so does a `null` default schema given for the database, which says it has no schemas. |
| `null-schema-tag` | warning | A `dimension` tag with no default in a transform, whose field names a table by a `null` schema, on a database whose engine has schemas. Metabase imports the field as an inactive stub, and the transform and its tests run, since such a tag compiles to `1 = 1`; the filter fails once the tag has a value. A `dimension` tag with a default, a `temporal-unit` tag and a card's tag give `null-schema-reference`. |
| `reads-not-checked` | warning | A transform, input or expectation whose tables or columns the lint could not find, such as SQL the parser cannot read. |

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
import {
  lint,
  MissingDefaultSchemasError,
} from "@metabase/representations/experimental";

const { results, passed, failed } = validateSchema({ folder: "./my-export" });
for (const result of results) {
  if (result.status === "fail") {
    console.log(result.file, result.errors);
  }
}

// lint is experimental and asynchronous, and rejects with a LintSetupError
// when it cannot run. MissingDefaultSchemasError is a LintSetupError.
try {
  const { files, findings } = await lint({
    folder: "./my-export",
    defaultSchemas: { Warehouse: "public" },
  });
} catch (e) {
  if (e instanceof MissingDefaultSchemasError) {
    console.log(e.databases); // [{ database, file, reason }, …]
  }
  throw e;
}

const entityId = generateEntityId(); // "LZfXLFzPPR4NNrgjlWDxn"
const uuid = generateUuid(); // "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8"
```
