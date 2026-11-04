# Metabase Representation Format

Metabase represents user-created content as a tree of YAML files. Each file represents one entity (a collection, card, dashboard, etc.). The format is designed to be **portable** across Metabase instances: numeric database IDs are replaced with human-readable names and entity IDs.

This repository contains the specification and examples of the format, and publishes `@metabase/representations`: Zod schemas of every entity, in two forms.

## Contents

- **[core-spec/v1/spec.md](core-spec/v1/spec.md)** — Full specification covering entity keys, folder structure, MBQL and native queries, parameters, and all entity types.
- **[src/domain/](src/domain/)** — The Zod schema of each entity type.
- **[examples/v1/](examples/v1/)** — Complete examples using the Sample Database.
- **[CONTRIBUTING.md](https://github.com/metabase/representations/blob/main/CONTRIBUTING.md)** — How releases and alpha builds from a pull request are published.

## Portable and instance forms

An entity references other things in two ways, and each entity has a schema for each:

- **Portable**, as the YAML files do: a database by name, a user by email, a table as `[database, schema, table]`, a field as `[database, schema, table, field]` (followed by the path of a JSON-unfolded field), and Metabase content by its 21-character `entity_id`. Every file carries `serdes/meta`.
- **Instance**, as the Metabase API does: the numeric id each of those has in one Metabase, with an optional `id` for the entity itself and optional `serdes/meta`.

Each schema exports a value and a type of the same name, `Portable<Model>` and `Instance<Model>`, where `<Model>` is the model Metabase writes in `serdes/meta`:

```ts
import yaml from "js-yaml";
import {
  getPortableModel,
  InstanceCard,
  PortableCard,
} from "@metabase/representations";

const document = yaml.load(text);
getPortableModel(document); // "Card"

const result = PortableCard.safeParse(document);
if (!result.success) {
  throw new Error(JSON.stringify(result.error.issues));
}
const card: PortableCard = result.data;

const body: InstanceCard = InstanceCard.parse(apiResponse);
```

`PortableQuery` and `InstanceQuery` validate a query on its own. Zod is a peer dependency.

## API

| Export | Description |
|--------|-------------|
| `Portable<Model>`, `Instance<Model>` | The schema and type of an entity in either form, for `Action`, `Card`, `Channel`, `Collection`, `Dashboard`, `DataApp`, `Database`, `Document`, `Field`, `FieldUserSettings`, `FieldValues`, `Glossary`, `Measure`, `Metabot`, `NativeQuerySnippet`, `PythonLibrary`, `Query`, `Segment`, `Table`, `Timeline`, `Transform`, `TransformJob`, `TransformTag`, and `TransformTest` |
| `getPortableModel(value)` | The model a parsed portable entity's `serdes/meta` ends with, or null |
| `generateEntityId()`, `generateUuid()` | A new 21-character entity id, or a v4 UUID |

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
