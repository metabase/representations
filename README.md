# Metabase Representation Format

Metabase represents user-created content as a tree of YAML files. Each file represents one entity (a collection, card, dashboard, etc.). The format is designed to be **portable** across Metabase instances: numeric database IDs are replaced with human-readable names and entity IDs.

This repository holds the specification and examples of the Metabase Representation Format, and the `@metabase/representations` package. The package's CLI validates a folder of YAML files against the schemas, and lints the transforms and transform tests in a folder, and the references between them, for what Metabase refuses or likely gets wrong.

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

Omit `--folder` to validate the current directory. It exits 1 when a file fails, and 2 when the folder has no YAML files in Metabase's top-level folders ([exit codes](#exit-codes)). A file with no `serdes/meta`, an empty file, or a file that holds only `[]` or `''` passes with a warning: Metabase skips it. A file of a model that Metabase imports and no schema here describes, such as `CustomVizPlugin` or `Dimension`, passes and is counted as not checked. A model outside the list of models Metabase imports fails, and so does a file that is not valid UTF-8.

The validator reads YAML as Metabase does, with a few [known differences](https://github.com/metabase/representations/blob/main/docs/lint.md#how-yaml-is-read).

## Lint

The lint is experimental. It is outside the package's semver guarantees: its rules, findings, output and options can change in any release. The `lint` command runs only with `--experimental`, and its programmatic API comes from `@metabase/representations/experimental`.

Check the transforms and transform tests in a folder, and the references between them, for what Metabase refuses or likely gets wrong, without a Metabase. The lint reads SQL with [Pyodide](https://pyodide.org), an optional peer dependency that a plain install of the package leaves out. Under `npx`, name both packages, Pyodide at the version the package pins:

```sh
npx -p @metabase/representations -p pyodide@314.0.7 representations lint --experimental --folder ./sync-repo
```

`npx @metabase/representations lint --experimental` cannot find a Pyodide installed in the project, because `npx` installs the package elsewhere. `npx` also skips a `-p` package that the project already installs. So in a project that installs Pyodide, also install `@metabase/representations`, and run `npx representations lint --experimental`. A tool that depends on the package installs Pyodide among its own dependencies:

```sh
npm install pyodide@314.0.7
```

Without Pyodide, a lint of a folder with SQL exits with code 2, and its message gives the `npx` and `npm install` commands above.

Omit `--folder` to lint the current directory. Give a database's default schema with `--default-schema "<database>=<schema>"`, or `"<database>="` for a database with no schemas. The option repeats, once per database, and overrides the settings file. The lint says on stderr what each one sets, and warns on a database that no file in the folder names.

The lint prints one JSON finding per line on stdout, grouped by rule, then by file, and a count on stderr. It exits 1 when a finding is an error, and 2 when it checks nothing ([exit codes](#exit-codes)). When a database needs a default schema the lint does not have, it warns once for that database (`missing-default-schema`), skips the comparisons that depend on it, and runs every other check. Each finding has these fields:

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

`.metabase-lint.json` at the root of the linted folder gives each database's default schema and engine, by database name as the files name it. Both keys are optional. It must be a regular file, not a symbolic link. The lint takes each database's engine only from this file, and its default schema from this file, `--default-schema` or the engine: remote sync writes no Database file, and the lint takes nothing from one. Without an engine, the engine checks and `null-schema-reference` give no finding, and `unknown-engine` warns. Without a default schema that it needs, the lint skips the comparisons that depend on it, and `missing-default-schema` warns. Give both for each database the repository's transforms and cards name:

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
| `dangling-transform-id` | error | A test whose `transform_id` matches no entity. |
| `wrong-type-transform-id` | error | A test whose `transform_id` names an entity that is not a transform. |
| `missing-default-schema` | warning | A database whose default schema the names in a file need, and that no source gives. The lint skips each comparison of an unqualified name with a qualified one in that database, or with a name an MBQL reference gives with a `null` schema, and runs every other check. |
| `duplicate-target` | warning | Two transforms that write the same table. |
| `transform-cycle` | error | Transforms that read each other's targets. |
| `transform-collection` | error | A transform whose collection is not in the folder, is not a collection, or is not in the `transforms` namespace. |
| `missing-incremental-table-tag` | error | An incremental native transform with no template tag of type table (`{{table}}`) for Metabase to filter new rows into, or none for the checkpoint field's table. |
| `missing-target-database` | error | A transform that is not a query transform and names no target database. |
| `blank-target-schema` | error | A transform whose target schema is blank. Metabase's API and a pull both refuse it. |
| `missing-target-schema` | warning | A transform whose target names no schema, on an engine with schemas. A pull accepts it, and a run writes to the default schema; Metabase's API refuses to save it. |
| `unsupported-transform-engine` | warning | A transform whose target database's engine cannot run that kind of transform. |
| `unknown-engine` | warning | A database that a transform or card writes to or reads and that has no engine the lint knows, so the checks that depend on the engine give no finding. Give it under `engines` in the settings file; an engine missing from the lint's table, such as a third-party driver, keeps the warning. |
| `empty-native-query` | warning | A transform whose native query is empty or only whitespace. Metabase accepts it, and every run fails. |
| `missing-input` | error | A test with no input for a table its transform reads. |
| `unused-input` | error | A test with an input for a table its transform does not read. |
| `untestable-transform` | error | A test of a transform that is not a query transform. |
| `untestable-engine` | warning | A test of a transform whose database's engine cannot run transform tests. |
| `duplicate-input` | error | Two inputs of one test for the same table. |
| `expectation-reads-other-table` | warning | A SQL expectation that reads a table other than the transform's target and the test's inputs. |
| `unparseable-test-sql` | error | A test whose expectation SQL SQLGlot cannot parse, as written, in the dialect of its database's engine: SQLGlot raises a ParseError or a TokenError, and Metabase refuses the test. On a database whose engine `.metabase-lint.json` does not give, such SQL gives `reads-not-checked`. A transform's SQL that does not parse gives `reads-not-checked` on the transform only. |
| `row-columns-mismatch` | error | The first row of a `rows` input or `equals` expectation whose keys are not exactly the declared columns. A key YAML reads as no string, such as `yes:` or `1:`, counts as not declared. Quote it, as `'1':`, or delete it when the row also has the quoted key. |
| `duplicate-expectation-name` | error | Two expectations of one test with the same name. |
| `null-schema-reference` | error | An MBQL reference in a card with a `null` schema, on a database whose engine has schemas. Metabase imports it as an inactive table, and refuses to run the card for a signed-in user. A transform's reference and a template tag give no finding. An unknown engine gives no finding, and so does a `null` default schema given for the database, which says it has no schemas. |
| `no-expectations` | warning | A test with no expectations. |
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
| 2 | Nothing was checked: a usage error (an unknown command or option, an option with no value or an invalid one, `lint` without `--experimental`), a folder that is missing, is not a folder or has no YAML files in Metabase's top-level folders, a lint that cannot run (an invalid settings file, a SQL parser that cannot start), or an unexpected error, such as a file or folder `lint` cannot read. |

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
