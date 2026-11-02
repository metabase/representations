# The lint in detail

How the `lint` command resolves tables, reads SQL and YAML, and where it can be wrong. The [README](../README.md) shows how to run it and lists its rules.

## How the lint reads SQL

The lint finds the tables native SQL reads with Metabase's own code: SQLGlot, at the version Metabase pins, and Metabase's `sql_tools.py`, run in WebAssembly by [Pyodide](https://pyodide.org). Nothing is fetched at run time. A CI job, on every pull request, every push to `main` and daily, fails when either differs from Metabase's `master`, or from Metabase at the commit `vendor/sources.json` records. When `sql_tools.py` differs, `bun run scripts/update-metabase-sources.ts` copies Metabase's file into `vendor/` and records its commit in `vendor/sources.json`.

- The SQL dialect follows the database's engine, as Metabase maps drivers to dialects. The map is copied from Metabase, and the same CI job fails when it differs from Metabase's `master` or from the Metabase commit `vendor/sources.json` records for it.
- Loading the parser takes a moment and some memory, once per process, and only when the lint reads SQL in the folder.
- Before it reads tables, the lint replaces each large literal list, such as an `IN` list of more than 100 literals, as Metabase does. Metabase also stops a parse after 30 seconds (`sql-parsing-timeout-ms`); the parser has no time limit.
- Pyodide is an optional peer dependency, which a plain install of the package leaves out. Install it with `npm install pyodide@314.0.7`, the version the package pins, where `@metabase/representations` is installed: a tool that depends on the package lists it among its own dependencies. Under `npx`, name both packages: `npx -p @metabase/representations -p pyodide@314.0.7 representations lint --experimental`; `npx` installs the package outside the project, where a Pyodide installed in the project is not found. Without Pyodide, a lint that reads SQL exits with code 2, and its message gives the `npm install` and `npx` commands.

## Which files are read

`lint` and `validate-schema` read the files Metabase's import reads: each `.yaml` file, at any depth, under `actions/`, `channels/`, `collections/`, `custom_viz_plugins/`, `databases/`, `embedding_themes/`, `glossary/`, `metabots/`, `osi_ai_context/`, `python_libraries/`, `python-libraries/`, `snippets/` and `transforms/`, and each `data_app.yaml` under `data_apps/`. Names match in their exact case, on any platform. A file whose name starts with a dot is not read. A file's model comes from its `serdes/meta`, not from its folder. A model that Metabase imports and no schema describes gives no finding. A model outside the list of models Metabase imports is an error, whatever Metabase does with the file. That list is Metabase's `exported-models` without `Setting`, which Metabase reads from `settings.yaml` alone. The list is copied from Metabase, and a CI job fails when it differs from Metabase's `master` or from the Metabase commit `vendor/sources.json` records for it.

Metabase reads each top-level key that ends in `_at`, and `last_analyzed`, as a time, and fails a file whose time it cannot read. So do `lint` and `validate-schema`: the value must be `null`, blank, or quoted text Metabase reads as a date or time. An unquoted `2024-01-05T10:00:00Z` fails, because YAML reads it as a timestamp, not text. The lint's reading of the text approximates Metabase's. It reads a zone as Java does, ignoring case: a region id, such as `America/New_York`, from Java's list (OpenJDK 25.0.1, time-zone data 2025b), or `Z`, `UTC`, `GMT` or `UT`, alone or with an offset, such as `UTC+01:00`. So it refuses `EST`, as Metabase does. A Metabase on a Java with other time-zone data knows other region ids. Two differences remain: after an offset, a zone written as an offset of whole hours, such as `+01:00[UTC+01]`, passes here, and Metabase refuses it; so does an offset written without a colon before a zone, such as `+0130[Europe/Paris]`. To find these keys, Metabase takes the name of every top-level key, which fails on a key that is not text, such as `1:` or `true:`: the lint and `validate-schema` fail that file too.

A symbolic link of such a name is an error, a `schema` error in the lint, whatever it points to: remote sync reads the link's text, the path it holds, not the file it points to, and the pull fails. Neither command reads the link's target. Remote sync does not descend into a symbolic link to a folder, and neither command reads a file inside one.

## How YAML is read

`lint` and `validate-schema` read each file as Metabase does: YAML 1.1 with SnakeYAML's rules, so `NO` is `false` and `017` is 15. They refuse what SnakeYAML refuses, such as an unknown tag, more than 50 aliases to a map or list, and a document longer than 3,145,728 code points. They also refuse an alias to a map or list that holds it, such as `x: &c {y: *c}`: Metabase cannot read the value it makes. `validate-schema` checks that a file is well formed: it fails a file that is not valid UTF-8, and a file with a key written twice in one map. It also fails a file or folder it cannot read, such as one whose permissions forbid it, and checks the others. A key that SnakeYAML reads as no string, such as a plain `1:` or `yes:`, stays under its text as written.

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
