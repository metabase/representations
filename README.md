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

## Lint

Check the references between transforms, tables and transform tests in a folder, without a Metabase:

```sh
npx @metabase/representations lint --folder ./my-export
```

It prints one JSON finding per line on stdout, grouped by rule, then by file, and a count on stderr. It exits 1 when a finding is an error, and 2 when it cannot run: an invalid settings file, or a default schema it needs and does not have.

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

An engine is Metabase's driver name, as a Database file's `engine` gives it. A Database file (`databases/<slug>/<slug>.yaml`) that names an engine takes precedence over the settings file. Remote sync does not export Database files, so a repository it writes needs `engines` for the lint to know them.

### Default schemas

An unqualified table name, such as `orders` in SQL, a transform's target or a test's input, resolves to its database's default schema.

An MBQL reference, `[database, schema, table]` or `[database, schema, table, field]`, names its schema as written, as Metabase's serdes import reads it: a `null` schema is the table with no schema, never the default schema. On a database whose default schema is `PUBLIC`, `["Sample Database", null, "ORDERS"]` is not `PUBLIC.ORDERS`, and an input for `PUBLIC.ORDERS` does not stand in for it. A Python transform's source table and a table file read a `null` schema the same way.

The lint needs the default schema of a database when an unqualified name is in it, or when one table name appears in two schemas. Without it, the lint stops before any check and names each such database.

It takes a database's default schema from the first of these that gives one:

1. `--default-schema "<database>=<schema>"` on the command line; `"<database>="` for no schemas.
2. The settings file's `defaultSchemas`; `null` for no schemas.
3. The Database file's `default_schema`, which a full serdes export writes. A file without the field, as Metabase wrote before it stored the value, gives none.
4. The engine: `mysql`, `bigquery-cloud-sdk`, `sqlite` and `mongo` have `null`, which Metabase hard-codes.

In a Database file, `default_schema` is the schema unqualified names resolve to, as Metabase's metadata sync last read it from the database. `null` there means Metabase resolves an unqualified name to no schema. On an engine with schemas, such as Postgres, `null` is ambiguous: the connection named no current schema, or Metabase has not synced the database since it began storing the value. The Metabase that runs the tests syncs on its own, so its value can differ. The lint therefore ignores `null` on an engine with schemas, and takes the default schema from the engine or asks for it. On an engine without schemas, or one the lint does not know, `null` means no schema.

### Target database

A query transform writes its target to its query's database. Any other transform, such as a Python one, writes to the database its target names. `source_database_id` never stands in for it; Metabase has no such fallback.

- `missing-target-database`, an error: a transform that is not a query transform names no target database. Metabase's API refuses it, and it cannot run; an import accepts it.

Such a transform has no target. No rule compares it with other tables, and the engine rules skip it.

### Engine rules

Three rules compare a transform with what its database's engine can do, from a table of Metabase driver features copied from Metabase's `master`:

- `missing-target-schema`, an error: a transform's target names no schema, on an engine with schemas. Metabase's API refuses such a transform; an import accepts it.
- `unsupported-transform-engine`, a warning: the engine cannot run that kind of transform, query or Python. Metabase's API refuses it.
- `untestable-engine`, a warning: a test of a transform whose source database's engine cannot run transform tests, such as Snowflake or BigQuery. Metabase refuses every run of it.

An engine missing from the table gives no finding, nor does a database whose engine the lint does not know. A driver can gain a feature in a later Metabase version than the table records, so the last two rules only warn.

### How it reads SQL

The lint finds the tables native SQL reads with Metabase's own code: SQLGlot, at the version Metabase pins, and Metabase's `sql_tools.py`, run in WebAssembly by [Pyodide](https://pyodide.org). Nothing is fetched at run time. A CI job fails when either differs from Metabase's `master`.

- The SQL dialect follows the database's engine, as Metabase maps drivers to dialects.
- Before parsing, the lint pastes in each snippet, keeps each optional clause `[[…]]` Metabase keeps when it compiles with no parameter values, and puts a placeholder word for each template tag.
- The columns a query reads and returns come from Metabase's `field_references`. A test's tables are replaced with Metabase's `replace_names`, with the replacements a transform test makes.
- Loading the parser costs about 1.5 seconds and 200–340 MB, once per process, and only when the folder holds SQL.

### Metabase version

The lint reads SQL as Metabase 0.65 does, from 0.65.0 through 0.65.2.1, and as `master` does at the commit `vendor/sources.json` records. Those versions pin the same SQLGlot, 30.20.0, and their `sql_tools.py` has the same `referenced_tables`, `field_references` and `replace_names`. The files can differ elsewhere, in functions the lint does not call.

Metabase 0.64 and earlier pin SQLGlot 28.6.0 and an older `referenced_tables` and `replace_names`. On those versions, the lint can find tables or columns that Metabase does not, or parse SQL that Metabase cannot, and the reverse. A later Metabase version can differ too; compare its `resources/python-sources/sql_tools.py` and `pyproject.toml` with the copy in `vendor/`.

### Known limits

Where SQLGlot reads a query wrong, Metabase reads it wrong the same way, and the lint agrees with Metabase. A query the parser cannot read is reported as `reads-not-checked`, a warning, never as a missing or unused input.

When neither a Database file nor the settings file gives a database's engine, the lint parses its SQL in SQLGlot's default dialect, where Metabase uses the engine's. Engine-specific syntax then fails to parse, for example backticked names in MySQL and BigQuery or bracketed names in SQL Server, and the query is reported as `reads-not-checked`.

Reported as `reads-not-checked`:

- SQL SQLGlot cannot parse, for example H2's `SELECT TOP 5 …`, and in ClickHouse `LIMIT 1 BY id LIMIT 100` or `WITH TOTALS` without `GROUP BY`.
- An expression nested deeper than Python's recursion limit: about 46 levels of parentheses.
- A snippet left in the query after pasting, such as one whose file is not in the folder.
- Snippets Metabase refuses to paste: a snippet that uses itself through any chain of snippets, more than 10,000 pastes in one query, or SQL longer than 10,000,000 characters after pasting.
- A query whose parse takes the parser past 2 GiB of memory, about 10,000,000 characters of SQL. Pyodide then garbles the parser's answers, so the queries read after it in the same run can be reported too.
- A native query on an engine whose native queries are not SQL, such as MongoDB. The lint does not parse it.

Read differently from what the database runs, with no warning:

- A table function reads no table: `generate_series(…)`, `UNNEST`, `LATERAL FLATTEN`, and in ClickHouse `numbers(…)`, `s3(…)` and a parameterized view `db.v(p = 1)`. So do ClickHouse's `remote('host', db.t)` and `cluster('c', db.t)`, which read `db.t`.
- In ClickHouse, `WHERE id IN db.u` misses `db.u`, and `WITH 1 AS orders SELECT * FROM orders` reads no table.
- The table an `INSERT`, `UPDATE`, `DELETE` or `MERGE` writes counts as read.
- A three-part name keeps its schema and table and drops the first part, even in MySQL, which has no three-part names.

The column checks (`input-missing-read-column`, `upstream-column-mismatch`, `table-qualified-column`) are warnings, and give no finding where they cannot decide:

- A column counts as read from a table only when it is qualified by the table or its alias, or its scope reads that one table. `SELECT *` reads no named column.
- Columns compare ignoring case. A quoted name that differs from an input's column only in case is not reported, though Postgres or Snowflake would not match the two.
- A transform's output columns are known only when its query is one native stage with a name for each column: no `*`, and an alias for each expression.
- SQL the parser cannot read gives no column finding.

`table-qualified-column` reports what a Metabase transform test refuses once it replaces the test's tables with temporary ones: a column qualifier that then names no table or alias. Metabase's rewrite also renames a qualifier that is the bare name of a replaced table, so most table-name qualifiers pass.

- No finding: `SELECT people.id FROM people JOIN orders o ON o.user_id = people.id`, and `SELECT orders.id FROM public.orders` when `public` is the default schema.
- A finding:
  - `SELECT orders.id FROM analytics.orders`, where `analytics` is not the default schema: the qualifier lacks the schema the table carries.
  - `SELECT "PEOPLE".id FROM people`: a quoted qualifier matches only as written.
  - `SELECT people.id FROM people WHERE EXISTS (SELECT 1 FROM orders people WHERE people.x = 1)`: a qualifier that is also an alias in the query.
  - `SELECT ghost.id FROM people`: a qualifier that names no table.

### Programmatic

`lint` is asynchronous, and rejects with a `LintSetupError` when it cannot run:

```js
import { lint, MissingDefaultSchemasError } from "@metabase/representations";

try {
  const { files, findings } = await lint({
    folder: "./my-export",
    defaultSchemas: { Warehouse: "public" },
  });
} catch (e) {
  if (e instanceof MissingDefaultSchemasError) {
    console.log(e.databases); // [{ database, reason }, …]
  }
}
```

## Publishing to NPM

Releases are published automatically by the **Release to NPM** GitHub Actions workflow on every push to `main`. The workflow compares the `version` in `package.json` against the version published on npm and publishes (with the `latest` dist-tag) if they differ.

To cut a release, bump `version` in `package.json` and merge to `main`.

The workflow requires an `NPM_RELEASE_TOKEN` secret with publish access to the `@metabase` npm org.
