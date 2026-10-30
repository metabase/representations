# The lint in detail

How the `lint` command resolves tables, reads SQL and YAML, and where it can be wrong. The [README](../README.md) shows how to run it and lists its rules.

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
