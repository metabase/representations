import {
  byObject,
  fields,
  items,
  lookup,
  unchanged,
  type Walk,
} from "./core.js";
import { serdesEntityRef, serdesTableRef } from "./paths.js";

const serdesCardRef = serdesEntityRef("Card");

const SMART_LINK_REFS: Readonly<Record<string, Walk>> = {
  card: serdesCardRef,
  dataset: serdesCardRef,
  dashboard: serdesEntityRef("Dashboard"),
  table: serdesTableRef,
};

const NODE_ATTRS_WALKS: Readonly<Record<string, Walk>> = {
  cardEmbed: fields({ id: serdesCardRef }),
  smartLink: byObject((attrs) =>
    fields({ entityId: lookup(SMART_LINK_REFS, attrs.model) ?? unchanged }),
  ),
};

export const walkProseMirror: Walk = byObject((node) =>
  fields({
    attrs: lookup(NODE_ATTRS_WALKS, node.type) ?? unchanged,
    content: items(walkProseMirror),
  }),
);
