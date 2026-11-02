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

Omit `--folder` to validate the current directory. It exits 1 when a file fails, or when the folder has no YAML files. A file with no `serdes/meta`, an empty file, or a file that holds only `[]` or `''` passes with a warning: Metabase skips it. A file of a model that Metabase imports and no schema here describes, such as `CustomVizPlugin` or `Dimension`, passes and is counted as not checked. A model outside the list of models Metabase imports fails, and so does a file that is not valid UTF-8.

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

`null` means the database has no schemas. An engine is Metabase's driver name, such as `postgres`, `snowflake` or `bigquery-cloud-sdk`.

### Lint rules

| Rule | Severity | What it catches |
|------|----------|-----------------|
| `schema` | error | A transform, transform test or snippet file that fails its schema, a file that does not parse as YAML or is not a YAML map, a file with a time Metabase cannot read, a file whose `serdes/meta` names no model or a model outside the models Metabase imports, a symbolic link in a folder Metabase imports, or a transform whose source database was deleted. |
| `invalid-utf8` | warning | A file that is not valid UTF-8. Metabase reads each invalid byte sequence as U+FFFD, and the lint reads the file the same way. |
| `skipped-by-metabase` | warning | A file with no `serdes/meta`, an empty file, or a file that holds only `[]` or `''`, which Metabase skips. |
| `database-file` | warning | A Database file. A pull creates a database connection from it, which remote sync never syncs or removes. The lint takes no engine or default schema from it, and does not check its schema. |
| `duplicate-yaml-key` | warning | A key written twice in one map of a file. Metabase keeps the last value, or the first in a merge source written after `<<:`, without a message. |
| `duplicate-entity-id` | warning | Two files of one model that hold the same `entity_id`. Remote sync keeps the last in path order (the paths sorted as strings, by UTF-16 code unit) and drops the others without a message. Files of different models may share an `entity_id`. |
| `missing-default-schema` | warning | A database whose default schema the names in a file need, and that no source gives. The lint skips each comparison of an unqualified name with a qualified one in that database, or with a name an MBQL reference gives with a `null` schema, and runs every other check. |
| `duplicate-target` | warning | Two transforms that write the same table. |
| `transform-cycle` | error | Transforms that read each other's targets. |
| `null-schema-reference` | error | An MBQL reference in a card with a `null` schema, on a database whose engine has schemas. Metabase imports it as an inactive table, and refuses to run the card for a signed-in user. A transform's reference and a template tag give no finding. An unknown engine gives no finding, and so does a `null` default schema given for the database, which says it has no schemas. |
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
import { lint } from "@metabase/representations/experimental";

const { results, passed, failed } = validateSchema({ folder: "./my-export" });
for (const result of results) {
  if (result.status === "fail") {
    console.log(result.file, result.errors);
  }
}

// lint is experimental and asynchronous, and rejects with a LintSetupError
// when it cannot run.
const { files, findings } = await lint({
  folder: "./sync-repo",
  defaultSchemas: { Warehouse: "public" },
});

const entityId = generateEntityId(); // "LZfXLFzPPR4NNrgjlWDxn"
const uuid = generateUuid(); // "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8"
```
