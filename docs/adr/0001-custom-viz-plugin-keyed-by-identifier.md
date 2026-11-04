---
status: accepted
---

# A Custom Viz Plugin is identified by its `identifier`, not an `entity_id`

Every other entity in the format carries a 21-character `entity_id` so references survive renames and moves between instances. A Custom Viz Plugin doesn't: the only thing that ever refers to one is a card's `display: custom:<identifier>` string, so the identifier already behaves as an immutable key, and Metabase's `CustomVizPlugin` model has no `entity_id` column (serdes uses `identifier` as the entity id). We key the entity by `identifier` alone rather than add a column, migration, backfill and serdes change for a value nothing would reference.

## Consequences

- The spec's rule "every file has an `entity_id`" gains its first exception.
- Identifiers are human-chosen, so two instances can both hold `my-chart`; merges collide where NanoIDs wouldn't.
- If Metabase ever lets a plugin be renamed without breaking cards, `display` would have to stop keying by identifier first; adding `entity_id` to the file then is additive.
