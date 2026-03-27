# Metabase Representation Format

**Version:** 1.0.0

## Overview

Metabase serialization (SerDes) exports instance configuration as a tree of YAML files. Each file represents one entity (a collection, card, dashboard, etc.). The format is designed to be **portable** across Metabase instances: numeric database IDs are replaced with human-readable names and entity IDs.

This specification covers user-created content entities. Database metadata entities (Database, Table, Field) are synced from connected databases and are outside the scope of this specification; they appear here only as foreign key references within user content.

## Table of Contents

1. [Entity Keys](#entity-keys)
2. [Folder Structure](#folder-structure)
3. [Collection](#collection)
4. [Card](#card)
5. [Dashboard](#dashboard)
6. [Segment](#segment)
7. [Measure](#measure)
8. [Transform](#transform)
9. [Snippet](#snippet)
10. [Parameter](#parameter)
11. [Query](#query)

---

## Entity Keys

Metabase uses two ways of identifying entities: `entity_id` (NanoID) and natural entity keys.

### NanoID

`entity_id` is a 21-character [NanoID](https://github.com/ai/nanoid) string (alphabet: `A-Za-z0-9_-`). It is the primary portable identifier used in cross-references. Once assigned, it does not change — the entity can be renamed or moved, but the `entity_id` remains stable.

### Foreign Key References

User content entities reference database objects using natural keys:

| Reference | Format | Example |
|-----------|--------|---------|
| Database FK | database name | `"Sample Database"` |
| Table FK | `[database, schema, table]` | `["Sample Database", "PUBLIC", "ORDERS"]` |
| Field FK | `[database, schema, table, field]` | `["Sample Database", "PUBLIC", "ORDERS", "TOTAL"]` |
| Collection FK | entity_id of collection | `"M-Q4pcV0qkiyJ0kiSWECl"` |
| Card FK | entity_id of card | `"f1C68pznmrpN1F5xFDj6d"` |
| Dashboard FK | entity_id of dashboard | `"Q_jD-f-9clKLFZ2TfUG2h"` |
| User FK | email address | `"internal@metabase.com"` |

For schemaless databases, the schema component is `null` (e.g., `["My Database", null, "my_table"]`).

### SerDes Meta

Every entity includes a `serdes/meta` array that encodes the entity's identity path. Each entry contains an `id` and `model` field. Entities identified by NanoID also include a `label` (slugified name).

```yaml
serdes/meta:
- id: NDzkGoTCdRcaRyt7GOepg
  label: my_entity_name
  model: Card
```

---

## Folder Structure

Collections are organized by namespace. The `main` namespace holds regular content (cards, dashboards, etc.), `snippets` holds SQL snippet collections, and `transforms` holds transform entities. All entity types within a collection are stored flat in the same folder — there are no `cards/`, `dashboards/` subdirectories.

```
export-root/
├── settings.yaml
├── collections/
│   ├── main/                               # Main namespace (regular content)
│   │   ├── {slug}.yaml                     # Entities in root collection
│   │   └── {collection_slug}/              # A collection folder
│   │       ├── {collection_slug}.yaml      # The collection's own definition
│   │       ├── {card_slug}.yaml            # Cards, dashboards, timelines, etc.
│   │       ├── {dashboard_slug}.yaml       #   — all flat in the same folder
│   │       └── {child_collection_slug}/    # Nested child collection
│   │           ├── {child_collection_slug}.yaml
│   │           └── ...
│   ├── snippets/                           # Snippets namespace
│   │   ├── {snippet_slug}.yaml             # Snippets in root snippet collection
│   │   └── {collection_slug}/              # Snippet collection folder
│   │       ├── {collection_slug}.yaml      # Collection definition (namespace: snippets)
│   │       └── {snippet_slug}.yaml
│   └── transforms/                         # Transforms namespace
│       └── {transform_slug}.yaml
├── databases/
│   └── {database_slug}/
│       ├── {database_slug}.yaml
│       ├── schemas/
│       │   └── {schema_slug}/
│       │       └── tables/
│       │           └── {table_slug}/
│       │               ├── {table_slug}.yaml
│       │               ├── segments/
│       │               │   └── {slug}.yaml
│       │               └── measures/
│       │                   └── {slug}.yaml
│       └── tables/                         # Schemaless databases
│           └── {table_slug}/
│               ├── {table_slug}.yaml
│               ├── segments/
│               │   └── {slug}.yaml
│               └── measures/
│                   └── {slug}.yaml
├── actions/
│   └── {slug}.yaml
├── glossary/
│   └── {term}.yaml
├── python_libraries/
│   └── {slug}.yaml
└── transforms/                             # Transform jobs and tags
    ├── transform_jobs/
    │   └── {slug}.yaml
    └── transform_tags/
        └── {slug}.yaml
```

### Path Construction Rules

- Entity files are named `{slug}.yaml` where slug is the slugified entity name (lowercase, spaces to underscores).
- Collection hierarchy is reflected in directory nesting within a namespace.
- All entity types within a collection (cards, dashboards, timelines, metabots, documents) are stored flat in the same folder — no type-specific subdirectories.
- Collections are partitioned by namespace: `main/` for regular content, `snippets/` for SQL snippets, `transforms/` for transforms.
- Segments and measures live under their table's directory in the `databases/` tree.
- Database, schema, and table folder names are slugified (e.g., `test-data (h2)` becomes `test_data__h2_`).
- Slashes in names are escaped as `__SLASH__`, backslashes as `__BACKSLASH__`.

---

## Collection

A collection is a folder-like container for organizing cards, dashboards, and other entities. Collection hierarchy is reflected in the directory structure.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Collection name |
| `entity_id` | string | Yes | NanoID identifier |
| `serdes/meta` | array | Yes | Identity path with `model: Collection` |
| `description` | string | No | Description |
| `slug` | string | No | URL-friendly name |
| `archived` | boolean | No | Whether archived (default: `false`) |
| `archived_directly` | boolean | No | Archived directly vs. inherited |
| `type` | string | No | `null` or `"instance-analytics"` |
| `namespace` | string | No | `null`, `"transforms"`, or `"snippets"` |
| `authority_level` | string | No | `null` or `"official"` |
| `parent_id` | string | No | Collection FK (entity_id of parent), `null` for root |
| `personal_owner_id` | string | No | User FK (email) for personal collections |
| `is_sample` | boolean | No | Sample collection flag |
| `created_at` | string | No | ISO 8601 timestamp |

### Example

```yaml
name: Marketing Analytics
entity_id: M-Q4pcV0qkiyJ0kiSWECl
description: Reports for the marketing team
slug: marketing_analytics
authority_level: official
created_at: '2024-08-28T09:46:18.671622Z'
serdes/meta:
- id: M-Q4pcV0qkiyJ0kiSWECl
  label: marketing_analytics
  model: Collection
```

---

## Card

A card represents a Question, Model, or Metric in Metabase. Cards are the primary way to save and share queries. Each card holds a `dataset_query` — see the [Query](#query) section.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Card name |
| `entity_id` | string | Yes | NanoID identifier |
| `display` | string | Yes | Visualization type: `"table"`, `"bar"`, `"line"`, `"pie"`, `"scalar"`, etc. |
| `creator_id` | string | Yes | User FK (email) |
| `dataset_query` | object | Yes | Query definition (see [Query](#query)) |
| `visualization_settings` | map | Yes | Display settings (can be empty `{}`) |
| `serdes/meta` | array | Yes | Identity path with `model: Card` |
| `description` | string | No | Description |
| `archived` | boolean | No | Whether archived (default: `false`) |
| `archived_directly` | boolean | No | Archived directly vs. inherited |
| `type` | string | No | `"question"`, `"model"`, or `"metric"` |
| `collection_id` | string | No | Collection FK (entity_id) |
| `collection_position` | integer | No | Position within collection |
| `collection_preview` | boolean | No | Show preview in collection (default: `true`) |
| `dashboard_id` | string | No | Dashboard FK (entity_id) |
| `document_id` | string | No | Document FK (entity_id) |
| `database_id` | string | No | Database FK (database name) |
| `table_id` | array | No | Table FK matching source-table in query |
| `source_card_id` | string | No | Card FK for source card |
| `parameters` | array | No | Native query parameters |
| `parameter_mappings` | array | No | Parameter mappings (unused, always empty) |
| `result_metadata` | array | No | Query result column metadata |
| `enable_embedding` | boolean | No | Embedding enabled |
| `embedding_params` | map | No | Embedding parameter config |
| `embedding_type` | string | No | `null`, `"sdk"`, `"standalone"` |
| `public_uuid` | string | No | Public sharing UUID |
| `made_public_by_id` | string | No | User FK (email) |
| `metabase_version` | string | No | Metabase version that created the card |
| `card_schema` | integer | No | Internal card schema version |
| `query_type` | string | No | `null`, `"query"`, or `"native"` |
| `created_at` | string | No | ISO 8601 timestamp |

### Example

```yaml
name: Products question
entity_id: f1C68pznmrpN1F5xFDj6d
display: table
creator_id: internal@metabase.com
type: question
dataset_query:
  database: Sample Database
  type: query
  query:
    source-table:
    - Sample Database
    - PUBLIC
    - PRODUCTS
visualization_settings: {}
collection_id: M-Q4pcV0qkiyJ0kiSWECl
serdes/meta:
- id: f1C68pznmrpN1F5xFDj6d
  label: products_question
  model: Card
```

---

## Dashboard

A dashboard is a collection of cards arranged in a grid layout. Dashboards contain dashboard cards (`dashcards`), parameters for filtering, and optional tabs.

Dashboard parameters are described in the [Parameter](#parameter) section.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Dashboard name |
| `entity_id` | string | Yes | NanoID identifier |
| `creator_id` | string | Yes | User FK (email) |
| `serdes/meta` | array | Yes | Identity path with `model: Dashboard` |
| `description` | string | No | Description |
| `archived` | boolean | No | Whether archived (default: `false`) |
| `archived_directly` | boolean | No | Archived directly vs. inherited |
| `collection_id` | string | No | Collection FK (entity_id) |
| `collection_position` | integer | No | Position within collection |
| `position` | integer | No | Display position |
| `auto_apply_filters` | boolean | No | Auto-apply filter changes (default: `true`) |
| `width` | string | No | `"fixed"` or `"full"` |
| `enable_embedding` | boolean | No | Embedding enabled |
| `embedding_params` | map | No | Embedding parameter config |
| `embedding_type` | string | No | `null`, `"sdk"`, `"standalone"` |
| `public_uuid` | string | No | Public sharing UUID |
| `made_public_by_id` | string | No | User FK (email) |
| `show_in_getting_started` | boolean | No | Show in getting started (default: `false`) |
| `caveats` | string | No | Known limitations |
| `points_of_interest` | string | No | Noteworthy features |
| `initially_published_at` | string | No | ISO 8601 timestamp |
| `parameters` | array | No | Dashboard parameters (see [Parameter](#parameter)) |
| `tabs` | array | No | Dashboard tabs |
| `dashcards` | array | No | Dashboard cards (see below) |
| `created_at` | string | No | ISO 8601 timestamp |

### DashboardCard

A dashboard card places a card (question) on the dashboard grid. Most dashboard cards reference an existing card via `card_id`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `entity_id` | string | Yes | NanoID identifier |
| `card_id` | string | Yes | Card FK (entity_id of the referenced card) |
| `row` | integer | Yes | Grid row position |
| `col` | integer | Yes | Grid column position |
| `size_x` | integer | Yes | Width in grid units |
| `size_y` | integer | Yes | Height in grid units |
| `serdes/meta` | array | Yes | Identity path: Dashboard → DashboardCard |
| `action_id` | string | No | Action FK (entity_id) |
| `dashboard_tab_id` | string | No | Tab FK |
| `inline_parameters` | array | No | Inline parameter overrides |
| `parameter_mappings` | array | No | Parameter-to-card mappings (see below) |
| `series` | array | No | Overlay series (see below) |
| `visualization_settings` | map | No | Display settings |
| `created_at` | string | No | ISO 8601 timestamp |

### ParameterMapping

Connects a dashboard parameter to a specific card column or variable. Each mapping lives in the `parameter_mappings` array of a DashboardCard. The `target` field specifies which column or variable the parameter maps to — see the [Parameter](#parameter) section for target formats.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `card_id` | string | Yes | Card FK (entity_id) |
| `parameter_id` | string | Yes | UUID matching a dashboard parameter's `id` |
| `target` | array | Yes | Parameter target (see [Parameter](#parameter)) |

### DashboardCardSeries

Overlays additional cards on the same dashboard card visualization (e.g., multiple lines on one chart).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `card_id` | string | Yes | Card FK (entity_id of the series card) |
| `position` | integer | Yes | Display order (starting at 0) |

### Example

```yaml
name: Orders Overview
entity_id: Q_jD-f-9clKLFZ2TfUG2h
creator_id: internal@metabase.com
parameters:
- id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
  name: Category
  slug: category
  type: string/=
dashcards:
- entity_id: UkpFcfUZMZt9ehChwnrAO
  card_id: f1C68pznmrpN1F5xFDj6d
  row: 0
  col: 0
  size_x: 8
  size_y: 4
  parameter_mappings:
  - card_id: f1C68pznmrpN1F5xFDj6d
    parameter_id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
    target:
    - dimension
    - - field
      - - Sample Database
        - PUBLIC
        - PRODUCTS
        - CATEGORY
      - null
  series:
  - card_id: OMuZ0wHe2O5Z_59-cLmn4
    position: 0
  visualization_settings: {}
  serdes/meta:
  - id: Q_jD-f-9clKLFZ2TfUG2h
    model: Dashboard
  - id: UkpFcfUZMZt9ehChwnrAO
    model: DashboardCard
serdes/meta:
- id: Q_jD-f-9clKLFZ2TfUG2h
  label: orders_overview
  model: Dashboard
```

---

## Segment

A segment is a saved filter definition. Segments allow reusable filters that can be applied across multiple questions and dashboards.

Each segment holds a `definition` that specifies the source table and filter criteria. See the [Query](#query) section for filter syntax.

Segments are stored under their table's directory: `databases/{db_slug}/schemas/{schema_slug}/tables/{table_slug}/segments/`.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Segment name |
| `entity_id` | string | Yes | NanoID identifier |
| `creator_id` | string | Yes | User FK (email) |
| `definition` | object | Yes | Filter definition with `source-table` and `filter` |
| `serdes/meta` | array | Yes | Identity path with `model: Segment` |
| `description` | string | No | Description |
| `archived` | boolean | No | Whether archived (default: `false`) |
| `created_at` | string | No | ISO 8601 timestamp |

### Example

```yaml
name: Widget products
entity_id: aB3kLmN9pQrStUvWxYz1a
creator_id: internal@metabase.com
definition:
  source-table:
  - Sample Database
  - PUBLIC
  - PRODUCTS
  filter:
  - =
  - - field
    - - Sample Database
      - PUBLIC
      - PRODUCTS
      - CATEGORY
    - null
  - Widget
serdes/meta:
- id: aB3kLmN9pQrStUvWxYz1a
  label: widget_products
  model: Segment
```

---

## Measure

A measure is a saved aggregation definition. Measures allow reusable aggregations that can be applied across multiple questions and dashboards.

Each measure holds a `definition` that specifies the database and aggregation clause. See the [Query](#query) section for aggregation syntax.

Measures are stored under their table's directory: `databases/{db_slug}/schemas/{schema_slug}/tables/{table_slug}/measures/`.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Measure name |
| `entity_id` | string | Yes | NanoID identifier |
| `creator_id` | string | Yes | User FK (email) |
| `definition` | object | Yes | Aggregation definition with `database` and `query.aggregation` |
| `serdes/meta` | array | Yes | Identity path with `model: Measure` |
| `description` | string | No | Description |
| `archived` | boolean | No | Whether archived (default: `false`) |
| `created_at` | string | No | ISO 8601 timestamp |

### Example

```yaml
name: Total revenue
entity_id: xK7mPqR2sT4uVwXyZ9a1b
creator_id: internal@metabase.com
definition:
  database: Sample Database
  query:
    aggregation:
    - - sum
      - - field
        - - Sample Database
          - PUBLIC
          - ORDERS
          - TOTAL
        - base-type: type/Float
serdes/meta:
- id: xK7mPqR2sT4uVwXyZ9a1b
  label: total_revenue
  model: Measure
```

---

## Transform

A transform generates a table in the database by running a query. Transforms allow materializing query results as persistent database tables. Transform entities are stored under `collections/transforms/`. Transform jobs and tags are stored separately under the top-level `transforms/` directory.

The `source` wraps a query that produces the data. See the [Query](#query) section for query syntax. The `target` specifies where the resulting table is written.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Transform name |
| `entity_id` | string | Yes | NanoID identifier |
| `creator_id` | string | Yes | User FK (email) |
| `source` | object | Yes | Source query wrapped in `type: query` |
| `target` | object | Yes | Target table: `database` (Database FK), `type` (`"table"`), `schema`, `name` |
| `serdes/meta` | array | Yes | Identity path with `model: Transform` |
| `description` | string | No | Description |
| `collection_id` | string | No | Collection FK (entity_id) |
| `created_at` | string | No | ISO 8601 timestamp |

### Example

```yaml
name: Product summary
entity_id: rT5vWxYz1aBcDeFgHiJkL
creator_id: internal@metabase.com
source:
  type: query
  query:
    database: Sample Database
    type: query
    query:
      source-table:
      - Sample Database
      - PUBLIC
      - PRODUCTS
target:
  database: Sample Database
  type: table
  schema: PUBLIC
  name: product_summary
collection_id: M-Q4pcV0qkiyJ0kiSWECl
serdes/meta:
- id: rT5vWxYz1aBcDeFgHiJkL
  label: product_summary
  model: Transform
```

---

## Snippet

A snippet is a reusable SQL fragment that can be referenced in native queries using `{{snippet: Snippet Name}}`. Snippets are stored under `collections/snippets/`, organized by snippet collection hierarchy.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Snippet name |
| `entity_id` | string | Yes | NanoID identifier |
| `creator_id` | string | Yes | User FK (email) |
| `content` | string | Yes | SQL content of the snippet |
| `serdes/meta` | array | Yes | Identity path with `model: NativeQuerySnippet` |
| `description` | string | No | Description |
| `archived` | boolean | No | Whether archived (default: `false`) |
| `collection_id` | string | No | Collection FK (entity_id) — snippets collection |
| `template_tags` | map | No | Template tag definitions (usually empty `{}`) |
| `created_at` | string | No | ISO 8601 timestamp |

### Example

```yaml
name: Active Order Filter
entity_id: xK7mPqR2sT4uVwXyZ9a1b
creator_id: internal@metabase.com
content: "STATUS = 'active' AND TOTAL > 0"
description: Filter for active orders with positive totals
serdes/meta:
- id: xK7mPqR2sT4uVwXyZ9a1b
  label: active_order_filter
  model: NativeQuerySnippet
```

### Usage in Native Queries

```yaml
native:
  query: "SELECT * FROM ORDERS WHERE {{snippet: Active Order Filter}}"
  template-tags:
    "snippet: Active Order Filter":
      type: snippet
      name: "snippet: Active Order Filter"
      id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
      display-name: Snippet: Active Order Filter
      snippet-name: Active Order Filter
      snippet-id: xK7mPqR2sT4uVwXyZ9a1b
```

---

## Parameter

A parameter is a filter control on a dashboard or card. Parameters are not standalone entities — they are embedded in the `parameters` array of their parent.

### Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | UUID identifier |
| `name` | string | Yes | Display name |
| `slug` | string | Yes | URL-friendly identifier |
| `type` | string | Yes | Filter widget type (see below) |
| `default` | any | No | Default value |
| `required` | boolean | No | Whether a value is required |
| `sectionId` | string | No | Parameter section grouping |
| `temporal_units` | array | No | Allowed temporal units (for `temporal-unit` type) |
| `values_query_type` | string | No | `"list"`, `"search"`, or `"none"` |
| `values_source_type` | string | No | `null`, `"card"`, or `"static-list"` |
| `values_source_config` | map | No | Values source configuration |

### Parameter Types

| Type | Description |
|------|-------------|
| `string/=`, `string/!=`, `string/contains`, `string/starts-with`, `string/ends-with` | String filters |
| `number/=`, `number/!=`, `number/>=`, `number/<=`, `number/between` | Number filters |
| `date/single`, `date/range`, `date/month-year`, `date/quarter-year`, `date/relative`, `date/all-options` | Date filters |
| `temporal-unit` | Temporal unit selector |
| `id` | ID filter |

### Parameter Targets

Parameter targets specify which column or variable a parameter maps to.

**MBQL — field reference:**

```yaml
target:
- dimension
- - field
  - - Sample Database
    - PUBLIC
    - PRODUCTS
    - CATEGORY
  - null
```

**MBQL — multi-stage field reference:**

```yaml
target:
- dimension
- - field
  - - Sample Database
    - PUBLIC
    - PRODUCTS
    - CATEGORY
  - null
- stage-number: 1
```

**Native — dimension/time-grouping variable:**

```yaml
target:
- dimension
- - template-tag
  - category_filter
```

**Native — text/number/date/boolean variable:**

```yaml
target:
- variable
- - template-tag
  - min_price
```

---

## Query

Metabase supports two query types: MBQL (structured) and native (SQL). Prefer MBQL queries when possible since they are easier to work with in Metabase. Use native queries when something is not supported in MBQL.

### MBQL Queries

MBQL queries are constructed via the graphical query editor. The general structure:

```yaml
database: Sample Database     # Database FK
type: query
query:
  source-table:               # Table FK
  - Sample Database
  - PUBLIC
  - PRODUCTS
```

This is equivalent to `SELECT * FROM PUBLIC.PRODUCTS`.

#### Field References

Fields are referenced using a `field` clause with a Field FK:

```yaml
- field
- - Sample Database           # database name
  - PUBLIC                    # schema (null for schemaless)
  - ORDERS                   # table name
  - TOTAL                    # field name
- null                        # field options (null, or map like {base-type: type/Float, temporal-unit: month})
```

#### Joins

```yaml
joins:
- source-table:
  - Sample Database
  - PUBLIC
  - PRODUCTS
  condition:
  - =
  - - field
    - - Sample Database
      - PUBLIC
      - ORDERS
      - PRODUCT_ID
    - null
  - - field
    - - Sample Database
      - PUBLIC
      - PRODUCTS
      - ID
    - null
  alias: Products
  strategy: left-join          # "left-join", "right-join", "inner-join", "full-join"
  fields: all                  # "all", "none", or list of field clauses
```

#### Expressions

Computed columns defined as named MBQL clauses:

```yaml
expressions:
  Profit:
  - -
  - - field
    - - Sample Database
      - PUBLIC
      - ORDERS
      - TOTAL
    - null
  - - field
    - - Sample Database
      - PUBLIC
      - ORDERS
      - TAX
    - null
```

Common operators: `+`, `-`, `*`, `/`, `concat`, `coalesce`, `case`, `abs`, `ceil`, `floor`, `round`, `upper`, `lower`, `trim`, `length`.

`case` expressions:

```yaml
expressions:
  Price Tier:
  - case
  - - - - ">"
      - - field
        - - Sample Database
          - PUBLIC
          - PRODUCTS
          - PRICE
        - null
      - 100
    - Premium
  - - - "<="
      - - field
        - - Sample Database
          - PUBLIC
          - PRODUCTS
          - PRICE
        - null
      - 100
    - Standard
```

Reference an expression in other clauses:

```yaml
- expression
- Profit
```

#### Filters

```yaml
filter:
- <operator>
- <field reference>
- <value>
```

Common operators: `=`, `!=`, `<`, `>`, `<=`, `>=`, `is-null`, `not-null`, `contains`, `starts-with`, `ends-with`, `between`.

Compound filters use `and` / `or`:

```yaml
filter:
- and
- - ">="
  - - field
    - - Sample Database
      - PUBLIC
      - PRODUCTS
      - PRICE
    - null
  - 10
- - "<"
  - - field
    - - Sample Database
      - PUBLIC
      - PRODUCTS
      - PRICE
    - null
  - 100
```

#### Aggregations

```yaml
aggregation:
- - <function>
  - <field reference>
```

Functions: `count`, `sum`, `avg`, `min`, `max`, `distinct`, `cum-sum`, `cum-count`. `count` does not require a field reference.

Multiple aggregations:

```yaml
aggregation:
- - count
- - sum
  - - field
    - - Sample Database
      - PUBLIC
      - ORDERS
      - TOTAL
    - base-type: type/Float
```

#### Breakouts

Group results by columns (like `GROUP BY`):

```yaml
breakout:
- - field
  - - Sample Database
    - PUBLIC
    - ORDERS
    - CREATED_AT
  - temporal-unit: month
```

Temporal units: `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`.

#### Order By

```yaml
order-by:
- - asc                        # "asc" or "desc"
  - - field
    - - Sample Database
      - PUBLIC
      - PRODUCTS
      - PRICE
    - null
```

Sort by aggregation result using the aggregation index:

```yaml
order-by:
- - desc
  - - aggregation
    - 0
```

#### Limit

```yaml
limit: 10
```

### Native Queries

Native queries use plain SQL with Metabase template tags:

```yaml
database: Sample Database
type: native
native:
  query: SELECT * FROM PRODUCTS
  template-tags: {}
```

#### Template Tags

| Type | Description | SQL usage |
|------|-------------|-----------|
| `text` | String variable | `WHERE COL = {{tag}}` |
| `number` | Number variable | `WHERE COL > {{tag}}` |
| `date` | Date variable | `WHERE COL > {{tag}}` |
| `boolean` | Boolean variable — `true` → `1 = 1`, `false` → `1 <> 1` | `WHERE {{tag}}` |
| `dimension` | Field filter — maps to a database field, Metabase generates the SQL | `WHERE {{tag}}` |
| `time-grouping` | Temporal grouping — replaced with `DATE_TRUNC(unit, col)` | `SELECT {{tag}}, COUNT(*)` |
| `card` | Saved card as CTE subquery | `SELECT * FROM {{#eid-name}}` |
| `snippet` | Reusable SQL fragment inlined | `WHERE {{snippet: Name}}` |
| `table` | Table reference | `SELECT * FROM {{tag}}` |

#### Template Tag Properties

```yaml
template-tags:
  tag_name:
    type: text                             # tag type (see table above)
    name: tag_name                         # must match the key
    id: a1b2c3d4-e5f6-7890-abcd-ef1234567890  # UUID
    display-name: Tag Name                 # display label
    default: null                          # default value
```

Additional properties for `dimension` type:

```yaml
    dimension:                             # Field FK
    - field
    - - Sample Database
      - PUBLIC
      - PRODUCTS
      - CATEGORY
    - null
    widget-type: string/=                  # filter widget type
```

Additional properties for `card` type:

```yaml
    card-id: f1C68pznmrpN1F5xFDj6d        # entity_id of the referenced card
```

Additional properties for `snippet` type:

```yaml
    snippet-name: Active Order Filter      # snippet name
    snippet-id: xK7mPqR2sT4uVwXyZ9a1b     # entity_id of the snippet
```

---

## Version History

- **1.0.0**: Initial release
  - Entity key system (NanoID and foreign key references)
  - Folder structure specification
  - Collection, Card, Dashboard entities (with DashboardCard, ParameterMapping, Series)
  - Segment, Measure, Transform, Snippet entities
  - Parameter system with targets
  - MBQL and Native query specifications
  - Template tags (text, number, date, boolean, dimension, time-grouping, card, snippet, table)

---

## License

See LICENSE file for details.
