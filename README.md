# Metabase Representation Format

Metabase represents user-created content as a tree of YAML files. Each file represents one entity (a collection, card, dashboard, etc.). The format is designed to be **portable** across Metabase instances: numeric database IDs are replaced with human-readable names and entity IDs.

This repository contains the specification, the JSON Schemas, and examples of the format, and publishes `@metabase/representations`, which validates entities and converts them between portable and instance references.

## Contents

- **[core-spec/v1/spec.md](core-spec/v1/spec.md)** — Full specification covering entity keys, folder structure, MBQL and native queries, parameters, and all entity types.
- **[src/schemas/](src/schemas/)** — JSON Schemas for each entity type.
- **[examples/v1/](examples/v1/)** — Complete examples using the Sample Database.
- **[examples/instance-ids.json](examples/instance-ids.json)** — An instance id for every reference the examples make, which the tests convert them with.
- **[CONTRIBUTING.md](https://github.com/metabase/representations/blob/main/CONTRIBUTING.md)** — How releases and alpha builds from a pull request are published.

## Portable and instance references

An entity references other things in two ways:

- **Portable**, as the YAML files do: a database by name, a user by email, a table as `[database, schema, table]`, a field as `[database, schema, table, field]` (followed by the path of a JSON-unfolded field), and Metabase content by its 21-character `entity_id`. A few slots wrap these:
  - a dashboard card, and a click behavior that opens a dashboard tab, name the tab as `[dashboard entity_id, tab entity_id]`;
  - a document names cards, dashboards and tables as serialization paths, such as `[{model: Card, id: entity_id}]`;
  - visualizer settings name a card inside a string, as `card:<entity_id>` or `$_card:<entity_id>_name`;
  - column settings and click behaviors key their entries by a field reference written as JSON text.
- **Instance**, as the Metabase API does: the numeric id each of those has in one Metabase.

The package converts an entity between the two without a Metabase. The caller resolves the references in between, usually with API requests, in two passes:

```js
import yaml from "js-yaml";
import {
  getInstanceEntity,
  getPortableKind,
  getPortableRefs,
  portableKey,
  validatePortable,
} from "@metabase/representations";

const document = yaml.load(text);
const kind = getPortableKind(document); // "Card"
const card = validatePortable("Card", document);
if (!card.ok) {
  throw new Error(JSON.stringify(card.issues));
}

const refs = getPortableRefs("Card", card.value);
// {
//   Card: ["f1C68pznmrpN1F5xFDj6d"],
//   Collection: ["M-Q4pcV0qkiyJ0kiSWECl"],
//   User: ["admin@example.com"],
//   Database: ["Sample Database"],
//   Table: [["Sample Database", null, "PRODUCTS"]],
//   Field: [["Sample Database", null, "PRODUCTS", "PRICE"], ...],
// }

const conversion = getInstanceEntity("Card", card.value, {
  Card: { f1C68pznmrpN1F5xFDj6d: 1 },
  Collection: { "M-Q4pcV0qkiyJ0kiSWECl": 2 },
  User: { "admin@example.com": 3 },
  Database: { "Sample Database": 4 },
  Table: { [portableKey(["Sample Database", null, "PRODUCTS"])]: 5 },
  Field: { [portableKey(["Sample Database", null, "PRODUCTS", "PRICE"])]: 6 },
  // ...
});
if (!conversion.ok) {
  throw new Error(`Unresolved: ${JSON.stringify(conversion.unresolved)}`);
}
```

A references object lists only the models an entity references, each reference once. The other direction is alike: `validateInstance`, then `getInstanceRefs`, then `getPortableEntity` with the portable reference of each id.

An entity, and each of a dashboard's tabs and cards, has an identity of its own. The instance form keeps its `entity_id` and adds its `id`, so `getPortableRefs` lists those entity ids too: the entity's own first, under its kind, and tabs and cards under `DashboardTab` and `DashboardCard`. An entity that is not in the instance yet still needs an id, and any integer converts: the Metabase API ignores the `id` of a new entity, and takes a negative id for a new dashboard tab or dashboard card. The portable form drops `id`, so `getInstanceRefs` does not list it, and `getPortableEntity` passes `serdes/meta` through, adding `[{model, id: entity_id}]` when it is missing.

A number where a portable reference belongs passes through unchanged, as Metabase's own import keeps it. The schemas reject one in the slots they describe, such as query field references; settings and result metadata are open objects, so a number there is taken as an instance id.

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
| `getPortableKind(value)` | The kind of a parsed portable entity, from its `serdes/meta`, or null |
| `KINDS`, `KIND_SCHEMAS` | The kinds, and the schema name of each |
| `REF_MODELS` | The models an entity can reference, the keys of every references object and map |
| `portableSchemas`, `instanceSchemas` | The JSON Schemas of both forms, keyed by `$ref` name |
| `generateEntityId()`, `generateUuid()` | A new 21-character entity id, or a v4 UUID |

Kinds and ref models are spelled as Metabase spells the `serdes/meta` model, such as `Card`, `NativeQuerySnippet` or `TransformTest`, so an entity's kind is also the ref model of its own id. `kind` is one of `Action`, `Card`, `Collection`, `Dashboard`, `Document`, `Measure`, `NativeQuerySnippet`, `PythonLibrary`, `Query`, `Segment`, `Transform`, `TransformJob`, `TransformTag`, and `TransformTest`; `Query` is a bare query, with no `serdes/meta`.

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
