# The lint in detail

How the `lint` command resolves tables, reads SQL and YAML, and where it can be wrong. The [README](../README.md) shows how to run it and lists its rules.

## The folder it expects

The lint expects the whole repository as Metabase's remote sync writes it: every collection, transform, transform test, snippet and table file of the content it lints. It reports what a file names and the folder lacks. For example, `transform-collection` reports a transform whose collection is not in the folder, though an import into a Metabase that already holds the collection accepts it. Lint a part of a repository, and such findings follow from the missing files.

## Default schemas

An unqualified table name, such as `orders` in SQL, a transform's target or a test's input, resolves to its database's default schema.

### Where the lint finds a default schema

The lint needs the default schema of a database when an unqualified name is in it, or when one transform test's tables name one table in two schemas. Without it, the lint stops before any check, and runs none. For each such database it names the first file that needs the default schema, and why.

Two qualified names, such as `a.account` and `b.account`, name different tables in every database, so they need no default schema. They depend on it only in a transform test: Metabase rewrites a test's SQL to stand-in tables, and it rewrites a qualified name that matches no input or target to a stand-in of the same name in the default schema. A test's tables are its inputs, its transform's target, the tables its expectations read, and the tables its transform reads by SQL. So `a.account` read by one transform and `b.account` by another need no default schema, but a test with an input `a.account` and an expectation that reads `b.account` does.

It takes a database's default schema from the first of these that gives one:

1. `--default-schema "<database>=<schema>"` on the command line, or the `defaultSchemas` option of the `lint` function; `"<database>="` or `null` for no schemas.
2. The settings file's `defaultSchemas`; `null` for no schemas.
3. The Database file's `default_schema`, which a full serdes export writes. A file without the field, as Metabase wrote before it stored the value, gives none.
4. The engine: `mysql`, `bigquery-cloud-sdk`, `sqlite` and `mongo` have `null`, which Metabase hard-codes.

### `null` in a Database file

In a Database file, `default_schema` is the schema unqualified names resolve to, as Metabase's metadata sync last read it from the database. `null` there means Metabase resolves an unqualified name to no schema.

On an engine with schemas, such as Postgres, `null` is ambiguous: the connection named no current schema, or Metabase has not synced the database since it began storing the value. The Metabase that runs the tests syncs on its own, so its value can differ. The lint therefore ignores `null` on an engine with schemas, and takes the default schema from the engine or asks for it.

On an engine without schemas, an engine whose schemas depend on the connection (such as Athena), or an engine the lint does not know, `null` means no schema.

### `null` schemas in MBQL references

An MBQL reference, `[database, schema, table]` or `[database, schema, table, field]`, names its schema as written, as Metabase's serdes import reads it: a `null` schema is the table with no schema, never the default schema. On a database whose default schema is `PUBLIC`, `["Sample Database", null, "ORDERS"]` is not `PUBLIC.ORDERS`, and an input for `PUBLIC.ORDERS` does not stand in for it: Metabase's import looks the reference up by its exact schema and name, finds no `ORDERS` with no schema, and creates an inactive table with no schema for it (`src/metabase/models/serialization/resolve/default.clj:123-130`, `src/metabase/models/db.clj:285-293`). The query then reads that table, never `PUBLIC.ORDERS`. A Python transform's source table and a table file read a `null` schema the same way. Findings name such a table `ORDERS (no schema)`, and an unqualified name `ORDERS`.

`null-schema-reference` is an error when a transform or a card names a table by a reference with a `null` schema, on a database whose engine has schemas, such as Postgres or H2. No synced table there has a `null` schema. Metabase's import creates an inactive table with no schema for the reference, and every query on it fails: for example `["Sample Database", null, "ORDERS"]` on the H2 Sample Database, whose table is `PUBLIC.ORDERS`. A transform is reported for the tables of the cards it reads too; a card, only for those its own query names. The rule needs no table files. A database whose engine the lint does not know, or whose engine has no schemas, gives no finding, nor does a table that a table file or a transform target with no schema names. A `null` default schema given for a database, in `.metabase-lint.json` or by `--default-schema "<database>="`, says the database has no schemas: it gives no finding either, whatever its engine.

### Case in table names

A table reference (MBQL or a Python source table), a table file and a transform target name a table exactly, as Metabase's import looks it up. `["Sample Postgres", "public", "Orders"]` is not the table file for `public.orders`: Metabase's import creates an inactive `Orders` table for it. Database names compare exactly too. `duplicate-target` is the exception: Metabase creates a target in quotes, as named, and Redshift folds every name to lower case, quoted or not, while its `enable_case_sensitive_identifier` setting is off, its default. So on Redshift two targets that differ only in case are one table. The lint does not fold on SQL Server or MySQL, whose case rule is a server setting (a collation, `lower_case_table_names`) that the folder does not give. An unquoted name read from SQL, and a transform test's input, compare ignoring case with any other name, as Metabase's transform-test validator compares them. In a transform test's expectation SQL, a quoted name compares as written, as Metabase's `replace_names` matches it: `analytics."T"` is not the target `analytics.t`.

## Engines

An engine is Metabase's driver name, as a Database file's `engine` gives it. A Database file (`databases/<slug>/<slug>.yaml`) that names an engine takes precedence over the settings file's `engines`.

### Remote-sync repositories

Remote sync does not export Database files. In a repository it writes, the lint learns each database's engine and default schema only from `.metabase-lint.json`. Give both for every database the transforms and cards name, by the name the files use:

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

Without an engine, the lint parses the database's SQL in SQLGlot's default dialect, and the rules that depend on the engine give no finding: `missing-target-schema`, `unsupported-transform-engine`, `untestable-engine` and `null-schema-reference`. `unknown-engine` warns once on each database a transform or card writes to or reads that has no engine the lint knows, so this silence is visible: a transform's target database and the databases of its Python source tables, a card's query's database, and the databases of the tables and native queries either names. An engine that the settings file names and the lint's table of Metabase's drivers lacks, such as a third-party driver, keeps the warning; check the driver name.

### Target database

A query transform writes its target to its query's database. Any other transform, such as a Python one, writes to the database its target names. `source_database_id` never stands in for it; Metabase has no such fallback.

`missing-target-database` is an error: a transform that is not a query transform names no target database. Metabase's API refuses it, and it cannot run; an import accepts it.

Such a transform has no target. No rule compares it with other tables, and the engine rules skip it.

### Engine rules

Three rules compare a transform with what its database's engine can do, from a table of Metabase driver features copied from Metabase at the commit `src/engines.ts` names:

- `missing-target-schema`, an error: a transform's target names no schema, on an engine with schemas. Metabase's API refuses such a transform; an import accepts it.
- `unsupported-transform-engine`, a warning: the engine cannot run that kind of transform, query or Python. Metabase's API refuses it.
- `untestable-engine`, a warning: a test of a query transform whose query's database (`source.query.database`, not `source_database_id`) has an engine that cannot run transform tests, such as Snowflake or BigQuery. Metabase refuses every run of it.

An engine missing from the table gives no finding, nor does a database whose engine the lint does not know; `unknown-engine` warns on both. A driver can gain a feature in a later Metabase version than the table records, so the last two rules only warn.

## How the lint reads SQL

The lint finds the tables native SQL reads with Metabase's own code: SQLGlot, at the version Metabase pins, and Metabase's `sql_tools.py`, run in WebAssembly by [Pyodide](https://pyodide.org). Nothing is fetched at run time. A CI job, on every pull request, every push to `main` and daily, fails when either differs from Metabase's `master`. When `sql_tools.py` differs, `bun run scripts/update-metabase-sources.ts` copies Metabase's file into `vendor/` and records its commit in `vendor/sources.json`.

- The SQL dialect follows the database's engine, as Metabase maps drivers to dialects.
- Before parsing, the lint pastes in each snippet, keeps each optional clause `[[…]]` Metabase keeps when it compiles with no parameter values, and puts a placeholder word for each template tag. It finds snippets, tags and clauses as Metabase's parser does: inside a `--` or `/* */` comment they are text. A transform test's own SQL, in an input or an expectation, is read as written, as Metabase runs it: a `[[`, a template tag or a snippet there does not parse, and is reported as `reads-not-checked`.
- Before it reads tables or columns, the lint replaces each large literal list as Metabase does: a `VALUES` clause of more than 100 tuples becomes one tuple of `NULL`s, and an `IN` list or `ARRAY` literal of only literals with at least 100 commas becomes `IN (NULL)` or `ARRAY[NULL]`. It does not replace them before `replace_names`, as Metabase does not.
- Loading the parser takes a moment and some memory, once per process, and only when the lint reads SQL in the folder.
- Pyodide is an optional peer dependency, which a plain install of the package leaves out. Install it with `npm install pyodide@314.0.7`, the version the package pins, where `@metabase/representations` is installed: a tool that depends on the package lists it among its own dependencies. Under `npx`, name both packages: `npx -p @metabase/representations -p pyodide@314.0.7 representations lint --experimental`; `npx` installs the package outside the project, where a Pyodide installed in the project is not found. Without Pyodide, a lint that reads SQL exits with code 2 and names both commands.

## Which files are read

`lint` and `validate-schema` read the files Metabase's import reads: each `.yaml` file, at any depth, under `actions/`, `channels/`, `collections/`, `custom_viz_plugins/`, `databases/`, `embedding_themes/`, `glossary/`, `metabots/`, `osi_ai_context/`, `python_libraries/`, `python-libraries/`, `snippets/` and `transforms/`, and each `data_app.yaml` under `data_apps/`. Names match in their exact case, on any platform. A file whose name starts with a dot is not read, nor is a symbolic link to nothing. A file's model comes from its `serdes/meta`, not from its folder. A model that Metabase imports and no schema describes gives no finding; a model Metabase does not import is an error. The list of models Metabase imports is copied from Metabase, and a CI job fails when it differs from Metabase's `master`.

Metabase reads each top-level key that ends in `_at`, and `last_analyzed`, as a time, and fails a file whose time it cannot read. So do `lint` and `validate-schema`: the value must be `null`, blank, or quoted text Metabase reads as a date or time. An unquoted `2024-01-05T10:00:00Z` fails, because YAML reads it as a timestamp, not text. The lint's reading of the text approximates Metabase's. It does not check a day past its month's end, such as `2024-02-30`. It knows the time zones JavaScript knows, not Java's: it passes `EST`, which Metabase refuses, and refuses `UT` and `UTC+01:00`, which Metabase reads. To find these keys, Metabase takes the name of every top-level key, which fails on a key that is not text, such as `1:` or `true:`: the lint and `validate-schema` fail that file too.

Known difference from Metabase: Metabase's import follows a symbolic link to a folder, and the lint and `validate-schema` do not. They read no file inside such a folder. A symbolic link to a file is read, as Metabase reads it.

## How YAML is read

A file that is not valid UTF-8 is an error; Metabase reads each invalid byte as U+FFFD instead. `lint` and `validate-schema` read each file as Metabase does: YAML 1.1 with SnakeYAML's rules, so `NO` is `false` and `017` is 15. They refuse what SnakeYAML refuses, such as an unknown tag, more than 50 aliases to a map or list, and a document longer than 3,145,728 code points. `lint` warns on a key written twice in one map (`duplicate-yaml-key`) and reads the last value, as Metabase does; `validate-schema` fails the file. A key that SnakeYAML reads as no string, such as a plain `1:` or `yes:`, stays under its text as written.

Known differences from Metabase's reading:

- A document whose aliases expand to more than 3,145,728 nodes is refused; Metabase reads it.
- An integer beyond 2^53 loses precision, where Metabase reads a `Long` or `BigInteger`. Two such keys that differ only past 2^53 are a duplicate key here and two keys in Metabase.
- Two date keys for the same time, such as `2024-01-05:` twice, are not reported as a duplicate key. Metabase reads one key and keeps the last value.
- An explicit tag on a value outside its type's plain form, such as `!!float 1` or `!!bool y`, is refused; Metabase reads `1.0` and `null`.
- `!!binary`, `!!set`, `!!omap` and `!!pairs` read as JavaScript's `Uint8Array`, `Set`, `Map` and a list of one-key maps.
- Deeply nested YAML is refused when the reader runs out of stack, which happens before Metabase's limit of 10,000 levels. Metabase can also stop below that limit when its thread's stack runs out first.

## Metabase versions

The lint reads SQL as Metabase 0.65 does, from 0.65.0 through 0.65.2.1, and as `master` does at the commit `vendor/sources.json` records. Those versions pin the same SQLGlot, 30.20.0, and their `sql_tools.py` has the same `referenced_tables`, `field_references` and `replace_names`. The files can differ elsewhere, in functions the lint does not call.

Metabase 0.64 and earlier pin SQLGlot 28.6.0 and an older `referenced_tables` and `replace_names`. On those versions, the lint can find tables or columns that Metabase does not, or parse SQL that Metabase cannot, and the reverse. A later Metabase version can differ too; compare its `resources/python-sources/sql_tools.py` and `pyproject.toml` with the copy in `vendor/`.

## Known limits

Where SQLGlot reads a query wrong, Metabase reads it wrong the same way, and the lint agrees with Metabase. A query the parser cannot read is reported as `reads-not-checked`, a warning, never as a missing or unused input. Metabase refuses a transform test whose transform or expectation SQL it cannot parse. So when the lint parses a test's SQL in its engine's dialect and SQLGlot cannot parse it, Metabase refuses the test. Other `reads-not-checked` warnings on a test, such as SQL parsed in the default dialect, a missing snippet file, or columns the parser cannot read, say nothing about Metabase's verdict.

When neither a Database file nor the settings file gives a database's engine, the lint parses its SQL in SQLGlot's default dialect, where Metabase uses the engine's. Engine-specific syntax then fails to parse, for example backticked names in MySQL and BigQuery or bracketed names in SQL Server, and the query is reported as `reads-not-checked`.

A query near Metabase's limit of 10,000,000 characters takes the parser a long time and much memory to read. The parser's memory never shrinks, so the rest of the run keeps that memory. Metabase stops a parse after 30 seconds (`src/metabase/sql_parsing/graal.clj` `call-timeout-ms`); the lint has no time limit, so it reads a query that Metabase gives up on.

### Reported as `reads-not-checked`

- SQL SQLGlot cannot parse, for example H2's `SELECT TOP 5 …`, and in ClickHouse `LIMIT 1 BY id LIMIT 100` or `WITH TOTALS` without `GROUP BY`.
- An expression nested deeper than Python's recursion limit allows, such as a deeply nested expression in parentheses.
- A snippet left in the query after pasting, such as one whose file is not in the folder.
- Template tags Metabase cannot parse, such as an unmatched `[[`, an empty `{{}}`, or an optional clause with no tag. Metabase refuses to run such a query.
- Snippets Metabase refuses to paste: a snippet that uses itself through any chain of snippets, more than 10,000 pastes in one query, or SQL longer than 10,000,000 characters after pasting.
- A native query on an engine whose native queries are not SQL, such as MongoDB. The lint does not parse it.

### Read differently from what the database runs, with no warning

- A table function reads no table: `generate_series(…)`, `UNNEST`, `LATERAL FLATTEN`, and in ClickHouse `numbers(…)`, `s3(…)` and a parameterized view `db.v(p = 1)`. So do ClickHouse's `remote('host', db.t)` and `cluster('c', db.t)`, which read `db.t`.
- In ClickHouse, `WHERE id IN db.u` misses `db.u`, and `WITH 1 AS orders SELECT * FROM orders` reads no table.
- The table an `INSERT`, `UPDATE`, `DELETE` or `MERGE` writes counts as read.
- A three-part name keeps its schema and table and drops the first part, even in MySQL, which has no three-part names.
