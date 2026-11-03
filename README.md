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

The package converts a list of entities between the two without a Metabase. A reference from one entity of the list to another resolves inside the list, so the caller resolves only references to anything outside it, usually with API requests, in two passes:

```js
import yaml from "js-yaml";
import {
  getInstanceEntities,
  getPortableKind,
  getPortableRefs,
  portableKey,
  validatePortable,
} from "@metabase/representations";

const items = texts.flatMap((text) => {
  const document = yaml.load(text);
  const kind = getPortableKind(document); // "Card", or null for a file of no kind
  if (kind === null) {
    return [];
  }
  const validation = validatePortable(kind, document);
  if (!validation.ok) {
    throw new Error(JSON.stringify(validation.issues));
  }
  return [{ kind, entity: validation.value }];
});

const refs = getPortableRefs(items);
// For two cards of the list, one built on the other, the other card is not listed:
// {
//   Collection: ["cOlQuErIeS0ExAmPlE2x1"], the collection both cards are in
//   User: ["admin@example.com"],
//   Database: ["Sample Database"],
//   Table: [["Sample Database", null, "PRODUCTS"]],
//   Field: [["Sample Database", null, "PRODUCTS", "PRICE"], ...],
// }

const conversion = getInstanceEntities(items, {
  User: { "admin@example.com": 1 },
  Database: { "Sample Database": 2 },
  Table: { [portableKey(["Sample Database", null, "PRODUCTS"])]: 3 },
  Field: { [portableKey(["Sample Database", null, "PRODUCTS", "PRICE"])]: 4 },
  // ...
});
if (!conversion.ok) {
  throw new Error(`Unresolved: ${JSON.stringify(conversion.unresolved)}`);
}
```

A references object lists only the models the entities reference, each reference once. The other direction is alike: `validateInstance`, then `getInstanceRefs`, then `getPortableEntities` with the portable reference of each id.

An entity, and each of a dashboard's tabs and cards, has an identity of its own. The instance form keeps its `entity_id` and adds its `id`. An entity of the list takes its id from the ids map when the map has it, under its kind (or `DashboardTab` and `DashboardCard`), and otherwise a negative id unique within the list, which references to it share. So the result is a valid instance form for editing and checking, and before writing to an instance the caller adds the real id of each entity it has: the Metabase API takes a negative id as a new dashboard tab or card, and ignores the `id` of a new entity of any other kind. In the other direction, an instance entity carries both its `id` and its `entity_id`, so references between entities of the list resolve without the caller. The portable form drops `id`, and `getPortableEntities` passes `serdes/meta` through, adding `[{model, id: entity_id}]` when it is missing.

A number where a portable reference belongs passes through unchanged, as Metabase's own import keeps it. The schemas reject one in the slots they describe, such as query field references; settings and result metadata are open objects, so a number there is taken as an instance id.

## API

| Export | Description |
|--------|-------------|
| `validatePortable(kind, value)` | Validates a value as a portable entity of `kind` |
| `validateInstance(kind, value)` | Validates a value as an instance entity of `kind` |
| `getPortableRefs(items)` | The distinct portable references of a list of entities to anything outside it, by model |
| `getInstanceEntities(items, ids)` | The entities with instance ids, or the references that `ids` does not resolve |
| `getInstanceRefs(items)` | The distinct instance ids a list of entities references outside it, by model |
| `getPortableEntities(items, refs)` | The entities with portable references, or the ids that `refs` does not resolve |
| `portableKey(ref)` | The key of a portable reference in the `ids` map of `getInstanceEntities` |
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
