# Metabase Representation Format

Metabase represents user-created content as a tree of YAML files. Each file represents one entity (a collection, card, dashboard, etc.). The format is designed to be **portable** across Metabase instances: numeric database IDs are replaced with human-readable names and entity IDs.

This repository contains the specification, the JSON Schemas, and examples of the format, and publishes `@metabase/representations`, which validates entities and converts them between portable and instance references.

## Contents

- **[core-spec/v1/spec.md](core-spec/v1/spec.md)** — Full specification covering entity keys, folder structure, MBQL and native queries, parameters, and all entity types.
- **[src/schemas/](src/schemas/)** — JSON Schemas for each entity type.
- **[examples/v1/](examples/v1/)** — Complete examples using the Sample Database.
- **[CONTRIBUTING.md](https://github.com/metabase/representations/blob/main/CONTRIBUTING.md)** — How releases and alpha builds from a pull request are published.

## Portable and instance references

An entity references other things in two ways:

- **Portable**, as the YAML files do: a database by name, a table as `[database, schema, table]`, a field as `[database, schema, table, field]`, a user by email, and Metabase content by `entity_id`.
- **Instance**, as the Metabase API does: the numeric id each of those has in one Metabase.

The package converts an entity between the two without a Metabase. The caller resolves the references in between, usually with API requests, in two passes:

```js
import {
  getInstanceEntity,
  getPortableRefs,
  portableKey,
  validatePortable,
} from "@metabase/representations";

const card = validatePortable("card", yaml.load(text));
if (!card.ok) {
  throw new Error(JSON.stringify(card.issues));
}

const refs = getPortableRefs("card", card.value);
// refs.databases: ["Sample Database"]
// refs.tables: [["Sample Database", "PUBLIC", "ORDERS"]]
// refs.collections: ["M-Q4pcV0qkiyJ0kiSWECl"], ...

const conversion = getInstanceEntity("card", card.value, {
  databases: { "Sample Database": 1 },
  tables: { [portableKey(["Sample Database", "PUBLIC", "ORDERS"])]: 2 },
  collections: { "M-Q4pcV0qkiyJ0kiSWECl": 3 },
  // ...
});
if (!conversion.ok) {
  throw new Error(`Unresolved: ${JSON.stringify(conversion.unresolved)}`);
}
```

The other direction mirrors it: `validateInstance`, then `getInstanceRefs`, then `getPortableEntity` with the portable reference of each id.

An entity's own `entity_id` is a reference too: the instance form keeps it and adds its `id`, as do dashboard tabs and dashboard cards, so a new one can take a negative id. The portable form drops `id`, and passes `serdes/meta` through, adding `[{model, id}]` when it is missing.

## API

| Export | Description |
|--------|-------------|
| `validatePortable(kind, value)` | Validates a value as a portable entity of `kind` |
| `validateInstance(kind, value)` | Validates a value as an instance entity of `kind` |
| `getPortableRefs(kind, entity)` | The distinct portable references of an entity, by model |
| `getInstanceEntity(kind, entity, refs)` | The entity with instance ids, or the references `refs` did not resolve |
| `getInstanceRefs(kind, entity)` | The distinct instance ids of an entity, by model |
| `getPortableEntity(kind, entity, refs)` | The entity with portable references, or the ids `refs` did not resolve |
| `mergePortableRefs(...refs)`, `mergeInstanceRefs(...refs)` | Merges the references of several entities |
| `portableKey(ref)` | The key of a portable reference in a `refs` map |
| `portableSchemas`, `instanceSchemas` | The JSON Schemas of both formats, keyed by `$ref` name |
| `generateEntityId()`, `generateUuid()` | A new 21-character entity id, or a v4 UUID |

`kind` is one of `action`, `card`, `collection`, `dashboard`, `document`, `measure`, `pythonLibrary`, `query`, `segment`, `snippet`, `transform`, `transformJob`, `transformTag`, and `transformTest`.

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
