# The lint in detail

How the `lint` command resolves tables, reads SQL and YAML, and where it can be wrong. The [README](../README.md) shows how to run it and lists its rules.

## The folder it expects

The lint expects the whole repository as Metabase's remote sync writes it: every collection, transform, transform test and snippet file of the content it lints. It reports what a file names and the folder lacks. For example, `transform-collection` reports a transform whose collection is not in the folder, though an import into a Metabase that already holds the collection accepts it. Lint a part of a repository, and such findings follow from the missing files.

## Default schemas

An unqualified table name, such as `orders` in SQL, a transform's target or a test's input, resolves to its database's default schema.

### Where the lint finds a default schema

The lint needs the default schema of a database when an unqualified name is in it, or when one transform test's tables name one table in two schemas, or name it both by an MBQL reference with a `null` schema and in a schema. Without it, the lint skips each comparison that depends on it: an unqualified name with a qualified one, or with a name an MBQL reference gives with a `null` schema. `missing-default-schema` warns once for each such database, on the first file that needs the default schema, says why, and names the other files as related files. Every other check runs.

It takes a database's default schema from the first of these that gives one:

1. `--default-schema "<database>=<schema>"` on the command line, or the `defaultSchemas` option of the `lint` function; `"<database>="` or `null` for no schemas.
2. The settings file's `defaultSchemas`; `null` for no schemas.
3. The engine: `mysql`, `bigquery-cloud-sdk`, `sqlite` and `mongo` have `null`, which Metabase hard-codes.

### `null` schemas in MBQL references

An MBQL reference, `[database, schema, table]` or `[database, schema, table, field]`, names its schema as written, as Metabase's serdes import reads it: a `null` schema is the table with no schema, never the default schema. On a Postgres database whose default schema is `public`, `["Warehouse", null, "orders"]` is not `public.orders`: Metabase's import looks the reference up by its exact schema and name, finds no `orders` with no schema, and creates an inactive table with no schema for it (`src/metabase/models/serialization/resolve/default.clj:123-130`, `src/metabase/models/db.clj:285-293`). Metabase compiles the reference without a schema, so the warehouse reads the table of that name in the default schema, `public.orders`. Metabase refuses a card's query that a signed-in user runs: the table it reads is inactive. A transform runs with no user, and reads `public.orders`. A transform test still takes an input for `public.orders` as standing in for it: Metabase compiles the reference to the unqualified name `orders`, and the test matches an unqualified name to an input in the default schema. A Python transform's source table reads a `null` schema the same way. Findings name such a table `orders (no schema)`, and an unqualified name `orders`.

`null-schema-reference` is an error when a card names a table by a reference with a `null` schema, on a database whose engine has schemas, such as Postgres or H2. Metabase's import creates an inactive table with no schema for the reference, and refuses to run a query that reads it for a signed-in user: for example `["Warehouse", null, "orders"]` on a Postgres database, whose table is `public.orders`. A transform's reference with a `null` schema, and a template tag's in a transform or a card, give no finding. The Sample Database is SQLite, which has no schemas, so `["Sample Database", null, "ORDERS"]` gives no finding. A card is reported only for the tables its own query names. A database whose engine the lint does not know, or whose engine has no schemas, gives no finding, nor does a table that a transform target with no schema names. A `null` default schema given for a database, in `.metabase-lint.json` or by `--default-schema "<database>="`, says the database has no schemas: it gives no finding either, whatever its engine.

### Case in table names

A table reference (MBQL or a Python source table) and a transform target name a table exactly, as Metabase's import looks it up. `["Sample Postgres", "public", "Orders"]` is not the table `public.orders`: Metabase's import creates an inactive `Orders` table for it. Database names compare exactly too. `duplicate-target` and `transform-cycle` compare them so on every engine, also on Redshift, whose warehouse folds every name to lower case by default. A name read from SQL, quoted or not, and a transform test's input, compare ignoring case with any other name, as Metabase's transform-test validator compares them.

## Engines

An engine is Metabase's driver name. The lint takes each database's engine only from `.metabase-lint.json`, and its default schema from that file, `--default-schema` or the engine, as [Default schemas](#default-schemas) lists: remote sync writes no Database file, and the lint takes nothing from one. A Database file gives the warning `database-file`: a pull creates a database connection from it, which remote sync never syncs or removes. Give both for every database the transforms and cards name, by the name the files use:

```json
{
  "engines": {
    "Warehouse": "postgres",
    "Events": "bigquery-cloud-sdk"
  },
  "defaultSchemas": {
    "Warehouse": "public",
    "Events": null
  }
}
```

## How the lint reads SQL

The lint finds the tables native SQL reads with Metabase's own code: SQLGlot, at the version Metabase pins, and Metabase's `sql_tools.py`, run in WebAssembly by [Pyodide](https://pyodide.org). Nothing is fetched at run time. A CI job, on every pull request, every push to `main` and daily, fails when either differs from Metabase's `master`, or from Metabase at the commit `vendor/sources.json` records. When `sql_tools.py` differs, `bun run scripts/update-metabase-sources.ts` copies Metabase's file into `vendor/` and records its commit in `vendor/sources.json`.

- The SQL dialect follows the database's engine, as Metabase maps drivers to dialects. The map is copied from Metabase, and the same CI job fails when it differs from Metabase's `master` or from the Metabase commit `vendor/sources.json` records for it.
- Before parsing, the lint pastes in each snippet by its template tag, as Metabase does, keeps each optional clause `[[…]]` Metabase keeps when it compiles with no parameter values, and puts a placeholder word for each template tag. A `table` tag reads its table where it stands in a table's place in the SQL that is kept. A `card` tag reads its card's tables where the SQL keeps the tag. A `dimension` or `temporal-unit` tag reads no table: Metabase writes its field as a column. In a stage with no template tags, Metabase substitutes nothing and runs the SQL as written, and the lint reads it as written: a `[[`, a `{{…}}` or a snippet reference there does not parse, and is reported as `reads-not-checked`. The lint finds snippets, tags and clauses as Metabase's parser does: inside a `--` or `/* */` comment they are text. A transform test's own SQL, in an input or an expectation, is read as written, as Metabase runs it: a `[[`, a template tag or a snippet there does not parse, and is reported as `reads-not-checked`.
- Before it reads tables or columns, the lint replaces each large literal list as Metabase does: a `VALUES` clause of more than 100 tuples becomes one tuple of `NULL`s, and an `IN` list or `ARRAY` literal of only literals with at least 100 commas becomes `IN (NULL)` or `ARRAY[NULL]`.
- Loading the parser takes a moment and some memory, once per process, and only when the lint reads SQL in the folder.
- Pyodide is an optional peer dependency, which a plain install of the package leaves out. Install it with `npm install pyodide@314.0.7`, the version the package pins, where `@metabase/representations` is installed: a tool that depends on the package lists it among its own dependencies. Under `npx`, name both packages: `npx -p @metabase/representations -p pyodide@314.0.7 representations lint --experimental`; `npx` installs the package outside the project, where a Pyodide installed in the project is not found. Without Pyodide, a lint that reads SQL exits with code 2, and its message gives the `npm install` and `npx` commands.

## Which files are read

`lint` and `validate-schema` read the files Metabase's import reads: each `.yaml` file, at any depth, under `actions/`, `channels/`, `collections/`, `custom_viz_plugins/`, `databases/`, `embedding_themes/`, `glossary/`, `metabots/`, `osi_ai_context/`, `python_libraries/`, `python-libraries/`, `snippets/` and `transforms/`, and each `data_app.yaml` under `data_apps/`. Names match in their exact case, on any platform. A file whose name starts with a dot is not read. A file's model comes from its `serdes/meta`, not from its folder. A model that Metabase imports and no schema describes gives no finding. A model outside the list of models Metabase imports is an error, whatever Metabase does with the file. That list is Metabase's `exported-models` without `Setting`, which Metabase reads from `settings.yaml` alone. The list is copied from Metabase, and a CI job fails when it differs from Metabase's `master` or from the Metabase commit `vendor/sources.json` records for it.

Metabase reads each top-level key that ends in `_at`, and `last_analyzed`, as a time, and fails a file whose time it cannot read. So do `lint` and `validate-schema`: the value must be `null`, blank, or quoted text Metabase reads as a date or time. An unquoted `2024-01-05T10:00:00Z` fails, because YAML reads it as a timestamp, not text. The lint's reading of the text approximates Metabase's. It reads a zone as Java does, ignoring case: a region id, such as `America/New_York`, from Java's list (OpenJDK 25.0.1, time-zone data 2025b), or `Z`, `UTC`, `GMT` or `UT`, alone or with an offset, such as `UTC+01:00`. So it refuses `EST`, as Metabase does. A Metabase on a Java with other time-zone data knows other region ids. Two differences remain: after an offset, a zone written as an offset of whole hours, such as `+01:00[UTC+01]`, passes here, and Metabase refuses it; so does an offset written without a colon before a zone, such as `+0130[Europe/Paris]`. To find these keys, Metabase takes the name of every top-level key, which fails on a key that is not text, such as `1:` or `true:`: the lint and `validate-schema` fail that file too.

A symbolic link of such a name is an error, a `schema` error in the lint, whatever it points to: remote sync reads the link's text, the path it holds, not the file it points to, and the pull fails. Neither command reads the link's target. Remote sync does not descend into a symbolic link to a folder, and neither command reads a file inside one.

## How YAML is read

`lint` and `validate-schema` read each file as Metabase does: YAML 1.1 with SnakeYAML's rules, so `NO` is `false` and `017` is 15. They refuse what SnakeYAML refuses, such as an unknown tag, more than 50 aliases to a map or list, and a document longer than 3,145,728 code points. They also refuse an alias to a map or list that holds it, such as `x: &c {y: *c}`: Metabase cannot read the value it makes. The two commands differ on two points, on purpose: `validate-schema` checks that a file is well formed, and `lint` predicts what Metabase does with it. A file that is not valid UTF-8 fails `validate-schema`; `lint` warns (`invalid-utf8`) and reads each invalid byte sequence as U+FFFD, as Metabase does, though Java can divide the bytes into sequences differently and so read a different number of U+FFFD. A key written twice in one map fails `validate-schema`; `lint` warns (`duplicate-yaml-key`) and reads the value Metabase keeps: the last, or the first in a merge source written in place, such as `<<: {k: 1, k: 2}`. A file or folder it cannot read, such as one whose permissions forbid it, fails `validate-schema`, which checks the others; `lint` stops at it. A key that SnakeYAML reads as no string, such as a plain `1:` or `yes:`, stays under its text as written.

Known differences from Metabase's reading:

- A document whose aliases expand to more than 3,145,728 nodes is refused; Metabase reads it.
- An integer beyond 2^53 loses precision, where Metabase reads a `Long` or `BigInteger`. Two such keys that differ only past 2^53 are a duplicate key here and two keys in Metabase.
- Two date keys for the same time, such as `2024-01-05:` twice, are not reported as a duplicate key. Metabase reads one key and keeps the last value.
- An explicit tag on a value outside its type's plain form, such as `!!float 1` or `!!bool y`, is refused; Metabase reads `1.0` and `null`.
- `!!binary`, `!!set`, `!!omap` and `!!pairs` read as JavaScript's `Uint8Array`, `Set`, `Map` and a list of one-key maps.
- Deeply nested YAML is refused when the reader runs out of stack, which happens before Metabase's limit of 10,000 levels. Metabase can also stop below that limit when its thread's stack runs out first.

## Metabase versions

The lint reads SQL as a Metabase version does that pins SQLGlot 30.20.0 and whose `sql_tools.py` has the same `referenced_tables` and `field_references` as the copy in `vendor/`: Metabase 0.65 from 0.65.0, and `master` at the commit `vendor/sources.json` records. The files can differ elsewhere, in functions the lint does not call.

Metabase 0.64 and earlier pin SQLGlot 28.6.0 and an older `referenced_tables`. On those versions, the lint can find tables or columns that Metabase does not, or parse SQL that Metabase cannot, and the reverse. A later Metabase version can differ too; compare its `resources/python-sources/sql_tools.py` and `pyproject.toml` with the copy in `vendor/`.

## Known limits

Where SQLGlot reads a query wrong, Metabase reads it wrong the same way, and the lint agrees with Metabase. A query the parser cannot read is reported as `reads-not-checked`, a warning, never as a missing or unused input. Metabase refuses a transform test whose transform or expectation SQL it cannot parse. So when the lint parses a test's SQL in its engine's dialect and SQLGlot cannot parse it, Metabase refuses the test. Other `reads-not-checked` warnings on a test, such as SQL parsed in the default dialect, a missing snippet file, or columns the parser cannot read, say nothing about Metabase's verdict.

When the settings file gives no engine for a database, the lint parses its SQL in SQLGlot's default dialect, where Metabase uses the engine's. Engine-specific syntax then fails to parse, for example backticked names in MySQL and BigQuery or bracketed names in SQL Server, and the query is reported as `reads-not-checked`.

A query near Metabase's limit of 10,000,000 characters takes the parser a long time and much memory to read. The parser's memory never shrinks, so the rest of the run keeps that memory. Metabase stops a parse after 30 seconds, the default of its setting `sql-parsing-timeout-ms`; the lint has no time limit, so it reads a query that Metabase gives up on.

### Reported as `reads-not-checked`

- SQL SQLGlot cannot parse, for example H2's `SELECT TOP 5 …`, and in ClickHouse `LIMIT 1 BY id LIMIT 100` or `WITH TOTALS` without `GROUP BY`.
- An expression nested deeper than Python's recursion limit allows, such as a deeply nested expression in parentheses.
- A snippet the lint cannot paste: one whose file is not in the folder, or one that no snippet tag defines. In a stage with template tags, Metabase refuses to run a query with a snippet no template tag defines, unless the snippet is in an optional clause: Metabase then leaves the clause out, and so does the lint. In a stage with no template tags, Metabase substitutes nothing and runs the SQL as written.
- Template tags Metabase cannot parse, such as an unmatched `[[`, an empty `{{}}`, or an optional clause with no tag. Metabase refuses to run such a query.
- Snippets Metabase refuses to paste: a snippet that uses itself through any chain of snippets, more than 10,000 pastes in one query, or SQL longer than 10,000,000 characters after pasting.
- A native query on an engine whose native queries are not SQL, such as MongoDB. The lint does not parse it.

### Not reported

Some queries fail in Metabase on every run, and the lint gives no finding:

- An MBQL transform that reads a table by a reference with a `null` schema, on a database with schemas, and has no fields, aggregation or breakout. Metabase imports the reference as a table with no fields, and the run fails, even when the database's default schema holds a table of that name.
- A field filter (a `dimension` tag) with a default, or a time grouping (a `temporal-unit` tag), on a field of a table the SQL does not read. Metabase writes the field with its table's name, a table the query does not read, so the query fails.

### Read differently from what the database runs, with no warning

- A table function reads no table: `generate_series(…)`, `UNNEST`, `LATERAL FLATTEN`, and in ClickHouse `numbers(…)`, `s3(…)` and a parameterized view `db.v(p = 1)`. So do ClickHouse's `remote('host', db.t)` and `cluster('c', db.t)`, which read `db.t`.
- In ClickHouse, `WHERE id IN db.u` misses `db.u`, and `WITH 1 AS orders SELECT * FROM orders` reads no table.
- The table an `INSERT`, `UPDATE`, `DELETE` or `MERGE` writes counts as read.
- A three-part name keeps its schema and table and drops the first part, even in MySQL, which has no three-part names.
