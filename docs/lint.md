# The lint in detail

How the `lint` command resolves tables, reads SQL and YAML, and where it can be wrong. The [README](../README.md) shows how to run it and lists its rules.

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
