import {
  byObject,
  fields,
  items,
  lazy,
  lookup,
  unchanged,
  type Walk,
} from "./core.js";
import { serdesEntityRef, serdesTableRef } from "./paths.js";

const cardRef = serdesEntityRef("cards", "Card");

const SMART_LINK_REFS: Readonly<Record<string, Walk>> = {
  card: cardRef,
  dataset: cardRef,
  dashboard: serdesEntityRef("dashboards", "Dashboard"),
  table: serdesTableRef,
};

const NODE_ATTRS_WALKS: Readonly<Record<string, Walk>> = {
  cardEmbed: fields({ id: cardRef }),
  smartLink: byObject((attrs) =>
    fields({ entityId: lookup(SMART_LINK_REFS, attrs.model) ?? unchanged }),
  ),
};

export const walkProseMirror: Walk = byObject((node) =>
  fields({
    attrs: lookup(NODE_ATTRS_WALKS, node.type) ?? unchanged,
    content: items(lazy(() => walkProseMirror)),
  }),
);
