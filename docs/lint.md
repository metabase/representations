# The lint in detail

How the `lint` command resolves tables, reads SQL and YAML, and where it can be wrong. The [README](../README.md) shows how to run it and lists its rules.

## Default schemas

An unqualified table name, such as `orders` in SQL, a transform's target or a test's input, resolves to its database's default schema.

### Where the lint finds a default schema

The lint needs the default schema of a database when an unqualified name is in it, or when one transform test's tables name one table in two schemas. Without it, the lint stops before any check and names each such database.

Two qualified names, such as `a.account` and `b.account`, denote the same table or not whatever the default schema is. They depend on it only in a transform test: Metabase rewrites a test's SQL to stand-in tables, and it rewrites a qualified name it has no key for to a table of the same name in the default schema. A test's tables are its inputs, its transform's target, the tables its expectations read, and the tables its transform reads by SQL. So `a.account` read by one transform and `b.account` by another need no default schema, but a test with an input `a.account` and an expectation that reads `b.account` does.

It takes a database's default schema from the first of these that gives one:

1. `--default-schema "<database>=<schema>"` on the command line; `"<database>="` for no schemas.
2. The settings file's `defaultSchemas`; `null` for no schemas.
3. The Database file's `default_schema`, which a full serdes export writes. A file without the field, as Metabase wrote before it stored the value, gives none.
4. The engine: `mysql`, `bigquery-cloud-sdk`, `sqlite` and `mongo` have `null`, which Metabase hard-codes.

### `null` in a Database file

In a Database file, `default_schema` is the schema unqualified names resolve to, as Metabase's metadata sync last read it from the database. `null` there means Metabase resolves an unqualified name to no schema.

On an engine with schemas, such as Postgres, `null` is ambiguous: the connection named no current schema, or Metabase has not synced the database since it began storing the value. The Metabase that runs the tests syncs on its own, so its value can differ. The lint therefore ignores `null` on an engine with schemas, and takes the default schema from the engine or asks for it.

On an engine without schemas, an engine whose schemas depend on the connection (such as Athena), or an engine the lint does not know, `null` means no schema.

### `null` schemas in MBQL references

An MBQL reference, `[database, schema, table]` or `[database, schema, table, field]`, names its schema as written, as Metabase's serdes import reads it: a `null` schema is the table with no schema, never the default schema. On a database whose default schema is `PUBLIC`, `["Sample Database", null, "ORDERS"]` is not `PUBLIC.ORDERS`, and an input for `PUBLIC.ORDERS` does not stand in for it. A Python transform's source table and a table file read a `null` schema the same way. Findings name such a table `ORDERS (no schema)`, and an unqualified name `ORDERS`.

`null-schema-reference` warns when a transform reads a table by a reference with a `null` schema, on a database whose default schema is known and is not `null`. Such a database rarely has a table with no schema. Where none exists, Metabase's import creates an inactive one, and every query on it fails: for example `["Sample Database", null, "ORDERS"]` on the H2 Sample Database, whose default schema is `PUBLIC`. The rule needs no table files. A database whose default schema is unknown gives no finding.

## Engines

An engine is Metabase's driver name, as a Database file's `engine` gives it. A Database file (`databases/<slug>/<slug>.yaml`) that names an engine takes precedence over the settings file's `engines`. Remote sync does not export Database files, so a repository it writes needs `engines` for the lint to know them.

### Target database

A query transform writes its target to its query's database. Any other transform, such as a Python one, writes to the database its target names. `source_database_id` never stands in for it; Metabase has no such fallback.

`missing-target-database` is an error: a transform that is not a query transform names no target database. Metabase's API refuses it, and it cannot run; an import accepts it.

Such a transform has no target. No rule compares it with other tables, and the engine rules skip it.

### Engine rules

Three rules compare a transform with what its database's engine can do, from a table of Metabase driver features copied from Metabase at the commit `src/engines.ts` names:

- `missing-target-schema`, an error: a transform's target names no schema, on an engine with schemas. Metabase's API refuses such a transform; an import accepts it.
- `unsupported-transform-engine`, a warning: the engine cannot run that kind of transform, query or Python. Metabase's API refuses it.
- `untestable-engine`, a warning: a test of a transform whose source database's engine cannot run transform tests, such as Snowflake or BigQuery. Metabase refuses every run of it.

An engine missing from the table gives no finding, nor does a database whose engine the lint does not know. A driver can gain a feature in a later Metabase version than the table records, so the last two rules only warn.

## How the lint reads SQL

The lint finds the tables native SQL reads with Metabase's own code: SQLGlot, at the version Metabase pins, and Metabase's `sql_tools.py`, run in WebAssembly by [Pyodide](https://pyodide.org). Nothing is fetched at run time. A CI job fails when either differs from Metabase's `master`.

- The SQL dialect follows the database's engine, as Metabase maps drivers to dialects.
- Before parsing, the lint pastes in each snippet, keeps each optional clause `[[…]]` Metabase keeps when it compiles with no parameter values, and puts a placeholder word for each template tag.
- The columns a query reads and returns come from Metabase's `field_references`. A test's tables are replaced with Metabase's `replace_names`, with the replacements a transform test makes.
- Loading the parser takes a moment and some memory, once per process, and only when the lint reads SQL in the folder.
- Pyodide is an optional peer dependency, which a plain install of the package leaves out. Install it with `npm install pyodide@314.0.7`, the version the package pins. Without it, a lint that reads SQL exits with code 2 and names that command.

## Which files are read

`lint` and `validate-schema` read the files Metabase's import reads: each `.yaml` file, at any depth, under `actions/`, `channels/`, `collections/`, `custom_viz_plugins/`, `databases/`, `embedding_themes/`, `glossary/`, `metabots/`, `osi_ai_context/`, `python_libraries/`, `python-libraries/`, `snippets/` and `transforms/`, and each `data_app.yaml` under `data_apps/`. A file whose name starts with a dot is not read. A file's model comes from its `serdes/meta`, not from its folder. A model that Metabase imports and no schema describes gives no finding; a model Metabase does not import is an error. The list of models Metabase imports is copied from Metabase, and a CI job fails when it differs from Metabase's `master`.

Known difference from Metabase: Metabase's import follows a symbolic link to a folder, and the lint and `validate-schema` do not. They read no file inside such a folder. A symbolic link to a file is read, as Metabase reads it.

## How YAML is read

`lint` and `validate-schema` read each file as Metabase does: YAML 1.1 with SnakeYAML's rules, so `NO` is `false` and `017` is 15. They refuse what SnakeYAML refuses, such as an unknown tag, more than 50 aliases to a map or list, and a document longer than 3,145,728 code points. A duplicate key is an error, although Metabase keeps the last value. A key that SnakeYAML reads as no string, such as a plain `1:` or `yes:`, stays under its text as written.

Known differences from Metabase's reading:

- An integer beyond 2^53 loses precision, where Metabase reads a `Long` or `BigInteger`. Two such keys that differ only past 2^53 are a duplicate key here and two keys in Metabase.
- Two date keys for the same time, such as `2024-01-05:` twice, are not reported as a duplicate key. Metabase reads one key and keeps the last value.
- An explicit tag on a value outside its type's plain form, such as `!!float 1` or `!!bool y`, is refused; Metabase reads `1.0` and `null`.
- `!!binary`, `!!set`, `!!omap` and `!!pairs` read as JavaScript's `Uint8Array`, `Set`, `Map` and a list of one-key maps.
- Deeply nested YAML is refused when the reader runs out of stack, which happens before Metabase's limit of 10,000 levels. Metabase can also stop below that limit when its thread's stack runs out first.

## Metabase versions

The lint reads SQL as Metabase 0.65 does, from 0.65.0 through 0.65.2.1, and as `master` does at the commit `vendor/sources.json` records. Those versions pin the same SQLGlot, 30.20.0, and their `sql_tools.py` has the same `referenced_tables`, `field_references` and `replace_names`. The files can differ elsewhere, in functions the lint does not call.

Metabase 0.64 and earlier pin SQLGlot 28.6.0 and an older `referenced_tables` and `replace_names`. On those versions, the lint can find tables or columns that Metabase does not, or parse SQL that Metabase cannot, and the reverse. A later Metabase version can differ too; compare its `resources/python-sources/sql_tools.py` and `pyproject.toml` with the copy in `vendor/`.

## Known limits

Where SQLGlot reads a query wrong, Metabase reads it wrong the same way, and the lint agrees with Metabase. A query the parser cannot read is reported as `reads-not-checked`, a warning, never as a missing or unused input.

When neither a Database file nor the settings file gives a database's engine, the lint parses its SQL in SQLGlot's default dialect, where Metabase uses the engine's. Engine-specific syntax then fails to parse, for example backticked names in MySQL and BigQuery or bracketed names in SQL Server, and the query is reported as `reads-not-checked`.

A query near Metabase's limit of 10,000,000 characters takes the parser a long time and much memory to read. The parser's memory never shrinks, so the rest of the run keeps that memory.

### Reported as `reads-not-checked`

- SQL SQLGlot cannot parse, for example H2's `SELECT TOP 5 …`, and in ClickHouse `LIMIT 1 BY id LIMIT 100` or `WITH TOTALS` without `GROUP BY`.
- An expression nested deeper than Python's recursion limit allows, such as a deeply nested expression in parentheses.
- A snippet left in the query after pasting, such as one whose file is not in the folder.
- Snippets Metabase refuses to paste: a snippet that uses itself through any chain of snippets, more than 10,000 pastes in one query, or SQL longer than 10,000,000 characters after pasting.
- A native query on an engine whose native queries are not SQL, such as MongoDB. The lint does not parse it.
- SQL whose tables the parser finds but whose columns it cannot, such as two statements, an `INSERT` or an `UPDATE`, when a column check reads it. The lint reports it once for each query.

### Read differently from what the database runs, with no warning

- A table function reads no table: `generate_series(…)`, `UNNEST`, `LATERAL FLATTEN`, and in ClickHouse `numbers(…)`, `s3(…)` and a parameterized view `db.v(p = 1)`. So do ClickHouse's `remote('host', db.t)` and `cluster('c', db.t)`, which read `db.t`.
- In ClickHouse, `WHERE id IN db.u` misses `db.u`, and `WITH 1 AS orders SELECT * FROM orders` reads no table.
- The table an `INSERT`, `UPDATE`, `DELETE` or `MERGE` writes counts as read.
- A three-part name keeps its schema and table and drops the first part, even in MySQL, which has no three-part names.

### Column checks

The column checks (`input-missing-read-column`, `upstream-column-mismatch`, `table-qualified-column`) are warnings, and give no finding where they cannot decide:

- A column counts as read from a table only when it is qualified by the table or its alias, or its scope reads that one table. `SELECT *` reads no named column.
- Columns compare ignoring case. A quoted name that differs from an input's column only in case is not reported, though Postgres or Snowflake would not match the two.
- A transform's output columns are known only when its query is one native stage with a name for each column: no `*`, and an alias for each expression.
- SQL whose columns the parser cannot read gives no column finding, and is reported as `reads-not-checked`.

`table-qualified-column` reports what a Metabase transform test refuses once it replaces the test's tables with temporary ones: a column qualifier that then names no table or alias. Metabase's rewrite also renames a qualifier that is the bare name of a replaced table, so most table-name qualifiers pass.

- No finding: `SELECT people.id FROM people JOIN orders o ON o.user_id = people.id`, and `SELECT orders.id FROM public.orders` when `public` is the default schema.
- A finding:
  - `SELECT orders.id FROM analytics.orders`, where `analytics` is not the default schema: the qualifier lacks the schema the table carries.
  - `SELECT "PEOPLE".id FROM people`: a quoted qualifier matches only as written.
  - `SELECT people.id FROM people WHERE EXISTS (SELECT 1 FROM orders people WHERE people.x = 1)`: a qualifier that is also an alias in the query.
  - `SELECT ghost.id FROM people`: a qualifier that names no table.
