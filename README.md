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

- **Portable**, as the YAML files do: a database by name, a user by email, a table as `[database, schema, table]`, a field as `[database, schema, table, field]` (followed by the path of a JSON-unfolded field), and Metabase content by its 21-character `entity_id`. A few slots wrap these: a dashboard card names its tab as `[dashboard entity_id, tab entity_id]`, and a document names cards, dashboards and tables as serialization paths such as `[{model: Card, id: entity_id}]`.
- **Instance**, as the Metabase API does: the numeric id each of those has in one Metabase.

The package converts an entity between the two without a Metabase. The caller resolves the references in between, usually with API requests, in two passes:

```js
import yaml from "js-yaml";
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
// refs.cards: ["f1C68pznmrpN1F5xFDj6d"], the card's own entity_id
// refs.databases: ["Sample Database"]
// refs.tables: [["Sample Database", "PUBLIC", "ORDERS"]]
// refs.collections: ["M-Q4pcV0qkiyJ0kiSWECl"], ...

const conversion = getInstanceEntity("card", card.value, {
  cards: { f1C68pznmrpN1F5xFDj6d: 1 },
  databases: { "Sample Database": 2 },
  tables: { [portableKey(["Sample Database", "PUBLIC", "ORDERS"])]: 3 },
  collections: { "M-Q4pcV0qkiyJ0kiSWECl": 4 },
  // ...
});
if (!conversion.ok) {
  throw new Error(`Unresolved: ${JSON.stringify(conversion.unresolved)}`);
}
```

The other direction is alike: `validateInstance`, then `getInstanceRefs`, then `getPortableEntity` with the portable reference of each id.

An entity, and each of a dashboard's tabs and cards, has an identity of its own. The instance form keeps its `entity_id` and adds its `id`, so `getPortableRefs` lists the entity's own `entity_id`, in the ref model that `KIND_SPECS[kind].refModel` names. An entity that is not in the instance yet needs an id too: the Metabase API ignores the `id` of a new entity, and takes a negative id for a new dashboard tab or dashboard card. The portable form drops `id`, so `getInstanceRefs` does not list it, and `getPortableEntity` passes `serdes/meta` through, adding `[{model, id: entity_id}]` when it is missing.

## API

| Export | Description |
|--------|-------------|
| `validatePortable(kind, value)` | Validates a value as a portable entity of `kind` |
| `validateInstance(kind, value)` | Validates a value as an instance entity of `kind` |
| `getPortableRefs(kind, entity)` | The distinct portable references of an entity, by ref model |
| `getInstanceEntity(kind, entity, ids)` | The entity with instance ids, or the references that `ids` does not resolve |
| `getInstanceRefs(kind, entity)` | The distinct instance ids of an entity, by ref model |
| `getPortableEntity(kind, entity, refs)` | The entity with portable references, or the ids that `refs` does not resolve |
| `mergePortableRefs(...refs)`, `mergeInstanceRefs(...refs)` | Merges the references of several entities |
| `portableKey(ref)` | The key of a portable reference in the `ids` map of `getInstanceEntity` |
| `KINDS`, `KIND_SPECS` | The kinds, and the schema, `serdes/meta` model and own ref model of each |
| `REF_MODELS` | The ref models, the keys of every references object and map |
| `portableSchemas`, `instanceSchemas` | The JSON Schemas of both forms, keyed by `$ref` name |
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
