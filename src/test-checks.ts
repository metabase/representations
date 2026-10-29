import type { Doc } from "./documents.js";
import type { TableKey } from "./tables.js";

/** Reports on `doc` when `table`, which it names, is unknown. */
export type TableCheck = (doc: Doc, table: TableKey) => void;
