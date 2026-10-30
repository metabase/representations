# Metabase Representation Format

Metabase represents user-created content as a tree of YAML files. Each file represents one entity (a collection, card, dashboard, etc.). The format is designed to be **portable** across Metabase instances: numeric database IDs are replaced with human-readable names and entity IDs.

This repository holds the specification and examples of the Metabase Representation Format, and the `@metabase/representations` package. The package's CLI validates a folder of YAML files against the schemas, and lints the references between transforms, tables and transform tests.

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

Omit `--folder` to validate the current directory. It exits 1 when a file fails, and 2 when the folder has no YAML files ([exit codes](#exit-codes)). A file with no `serdes/meta`, or an empty file, passes with a warning: Metabase skips it. A file of a model that Metabase imports and no schema here describes, such as `CustomVizPlugin` or `Dimension`, passes and is counted as not checked. A model that Metabase does not import fails.

The validator reads YAML as Metabase does, with a few [known differences](https://github.com/metabase/representations/blob/main/docs/lint.md#how-yaml-is-read).

## Lint

The lint is experimental. It is outside the package's semver guarantees: its rules, findings, output and options can change in any release. The `lint` command runs only with `--experimental`, and its programmatic API comes from `@metabase/representations/experimental`.

Check the references between transforms, tables and transform tests in a folder, without a Metabase:

```sh
npx @metabase/representations lint --experimental --folder ./my-export
```

The lint reads SQL with [Pyodide](https://pyodide.org), an optional peer dependency that a plain install of the package leaves out. Install it, at the version the package pins, where `@metabase/representations` is installed, for the lint to read SQL. A tool that depends on the package installs it among its own dependencies:

```sh
npm install pyodide@314.0.7
```

Without it, a lint of a folder with SQL exits with code 2 and names that command.

Omit `--folder` to lint the current directory. Give a database's default schema with `--default-schema "<database>=<schema>"`, or `"<database>="` for a database with no schemas. The option repeats, once per database, and overrides the settings file. The lint says on stderr what each one sets, and warns on a database that no file in the folder names.

The lint prints one JSON finding per line on stdout, grouped by rule, then by file, and a count on stderr. It exits 1 when a finding is an error, and 2 when it checks nothing ([exit codes](#exit-codes)). When a database needs a default schema the lint does not have, it names each such database and the first file that needs it, and runs no check. Each finding has these fields:

| Field | Value |
|-------|-------|
| `rule` | The rule, from [Lint rules](#lint-rules). |
| `severity` | `error` or `warning`, fixed by the rule. |
| `file` | The file the finding is on, relative to the folder. |
| `entity` | The entity in that file: `model`, `entity_id` and `name`, each `null` when the file has none. |
| `message` | What is wrong, in words. |
| `related` | Other files involved, such as the transform a test tests; often empty. |

[The lint in detail](https://github.com/metabase/representations/blob/main/docs/lint.md) explains how it resolves default schemas, reads SQL and YAML, and where it can be wrong.

### Settings file

`.metabase-lint.json` at the root of the linted folder gives each database's default schema and engine, by database name as the files name it. Both keys are optional:

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

`null` means the database has no schemas. An engine is Metabase's driver name, such as `postgres`. A Database file that names an engine takes precedence.

### Lint rules

| Rule | Severity | What it catches |
|------|----------|-----------------|
| `schema` | error | A transform, transform test, table, Database or snippet file that fails its schema, a file that is not a YAML map, or a file whose `serdes/meta` names no model or a model Metabase does not import. |
| `skipped-by-metabase` | warning | A file with no `serdes/meta`, or an empty file, which Metabase skips. |
| `duplicate-entity-id` | warning | Two files of one model that hold the same `entity_id`. Metabase keeps the last in path order and drops the others without a message. Files of different models may share an `entity_id`. |
| `dangling-transform-id` | error | A test whose `transform_id` matches no entity. |
| `wrong-type-transform-id` | error | A test whose `transform_id` names an entity that is not a transform. |
| `duplicate-target` | warning | Two transforms that write the same table. |
| `transform-cycle` | error | Transforms that read each other's targets. |
| `transform-collection` | error | A transform whose collection is not in the folder, is not a collection, or is not in the `transforms` namespace. |
| `missing-incremental-table-tag` | error | An incremental native transform with no table variable (a `{{table}}` template tag) for Metabase to filter new rows into, or none for the checkpoint field's table. |
| `missing-target-database` | error | A transform that is not a query transform and names no target database. |
| `missing-target-schema` | error | A transform whose target names no schema, on an engine with schemas. |
| `unsupported-transform-engine` | warning | A transform whose target database's engine cannot run that kind of transform. |
| `empty-native-query` | warning | A transform whose native query is empty or only whitespace. Metabase accepts it, and every run fails. |
| `missing-input` | error | A test with no input for a table its transform reads. |
| `unused-input` | error | A test with an input for a table its transform does not read. |
| `untestable-transform` | error | A test of a transform that is not a query transform. |
| `untestable-engine` | warning | A test of a transform whose database's engine cannot run transform tests. |
| `duplicate-input` | error | Two inputs of one test for the same table. |
| `expectation-reads-other-table` | error | A SQL expectation that reads a table other than the transform's target and the test's inputs. |
| `row-columns-mismatch` | error | The first row of a `rows` input or `equals` expectation whose keys are not exactly the declared columns. A key YAML reads as no string, such as `yes:` or `1:`, counts as not declared; quote it as `'1':`. |
| `duplicate-expectation-name` | error | Two expectations of one test with the same name. |
| `null-schema-reference` | warning | An MBQL reference with a `null` schema, on a database whose default schema is known and is not `null`. |
| `no-expectations` | warning | A test with no expectations. |
| `input-missing-read-column` | warning | A test input without a column its transform reads. |
| `upstream-column-mismatch` | warning | A test input for another transform's target, with a column that transform does not return. |
| `table-qualified-column` | warning | A SQL column qualifier that names no table or alias once a transform test replaces the tables. |
| `live-sql-input` | warning | A test's SQL input that reads a real table, so the test depends on live data. |
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

## Exit codes

Every command exits with one of these codes; `representations --help` prints the same table.

| Code | Meaning |
|------|---------|
| 0 | The command ran. `validate-schema`: no file failed; `lint`: no finding is an error. |
| 1 | `validate-schema`: a file failed; `lint`: a finding is an error. |
| 2 | Nothing was checked: a usage error (an unknown command or option, an option with no value or an invalid one, `lint` without `--experimental`), a folder that is missing, is not a folder or holds no YAML files, or a lint that cannot run (an invalid settings file, an unknown default schema, a SQL parser that cannot start). |

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
