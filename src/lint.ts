import {
  displayName,
  type Doc,
  indexByEntityId,
  loadDocs,
  validDocsOf,
} from "./documents.js";
import {
  LINT_RULE_SEVERITY,
  LINT_RULES,
  type LintEntity,
  type LintFinding,
  type Report,
} from "./findings.js";
import { cyclePath, cycles } from "./graph.js";
import { createReader, type Transform, transformOf } from "./reads.js";
import {
  type DefaultSchemaOf,
  fold,
  sameTable,
  tableLabel,
  type TableKey,
  type TableName,
} from "./tables.js";
import { reportTestFindings, type TableCheck } from "./test-checks.js";
import { stringOrNull } from "./values.js";

export type LintOptions = {
  folder: string;
  /**
   * The schema an unqualified table name resolves to, by database name, as
   * Metabase's driver reports it; null for a database with no schemas. A
   * database not listed has an unknown default schema.
   */
  defaultSchemas?: Record<string, string | null>;
};

export type LintResult = {
  files: number;
  findings: LintFinding[];
};

const LINTED_MODELS = new Set(["Transform", "TransformTest", "Table"]);

function entityOf(doc: Doc): LintEntity {
  return {
    model: doc.model,
    entity_id: stringOrNull(doc.body.entity_id),
    name: stringOrNull(doc.body.name),
  };
}

/**
 * For each transform whose sources were read, by index: the indexes of the
 * transforms whose target it reads.
 */
function readEdges(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
): Map<number, number[]> {
  const edges = new Map<number, number[]>();
  transforms.forEach((transform, i) => {
    if (transform.reads.status !== "read") {
      return;
    }
    const reads = transform.reads.tables;
    edges.set(
      i,
      transforms.flatMap((upstream, j) =>
        reads.some((t) => sameTable(t, upstream.target, defaultSchemaOf))
          ? [j]
          : [],
      ),
    );
  });
  return edges;
}

/**
 * For each transform in turn: a warning when its sources could not be read,
 * then a warning when another transform writes the same target.
 */
function reportUnreadSourcesAndDuplicateTargets(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  for (const transform of transforms) {
    if (transform.reads.status === "unread") {
      report(
        "reads-not-checked",
        transform.doc,
        `could not find the tables this transform reads: ${transform.reads.reason}`,
      );
    }
    const clashes = transforms.filter(
      (other) =>
        other !== transform &&
        sameTable(transform.target, other.target, defaultSchemaOf),
    );
    if (clashes.length > 0) {
      report(
        "duplicate-target",
        transform.doc,
        `target ${tableLabel(transform.target)} is also written by ${clashes.length} other transform(s)`,
        clashes.map((c) => c.doc.file),
      );
    }
  }
}

/** Runs the unknown-table check on every table each transform reads. */
function checkReadTablesKnown(
  transforms: readonly Transform[],
  checkKnown: TableCheck,
): void {
  for (const transform of transforms) {
    if (transform.reads.status === "read") {
      for (const table of transform.reads.tables) {
        checkKnown(transform.doc, table);
      }
    }
  }
}

/**
 * Returns a check that warns when a table, named by a document, is defined by
 * no table file and no transform target. It checks only tables of databases
 * that have at least one table file: a repo holds only some table files.
 */
function createUnknownTableCheck(
  docs: readonly Doc[],
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): TableCheck {
  const tableDocs = validDocsOf(docs, "Table");
  const tableFileDatabases = new Set<string | null>(
    tableDocs.map((d) => fold(d.body.db_id)),
  );
  const knownTables: TableKey[] = [
    ...tableDocs.map((d) => ({
      database: d.body.db_id,
      schema: d.body.schema ?? null,
      name: d.body.name,
    })),
    ...transforms.map((t) => t.target),
  ];
  return (doc: Doc, table: TableKey) => {
    if (
      tableFileDatabases.has(fold(table.database)) &&
      !knownTables.some((k) => sameTable(k, table, defaultSchemaOf))
    ) {
      report(
        "unknown-table",
        doc,
        `table ${tableLabel(table)} is defined by no table file or transform target`,
      );
    }
  };
}

/**
 * Reports each cycle among transforms, on its first member in file order. The
 * message follows one cycle from that member, each transform reading the
 * next one's target.
 */
function reportCycles(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  const edges = readEdges(transforms, defaultSchemaOf);
  for (const component of cycles(edges, transforms.length)) {
    const [first, ...rest] = component.map((i) => transforms[i]);
    report(
      "transform-cycle",
      first.doc,
      `transforms read each other's targets: ${cyclePath(edges, component)
        .map((i) => displayName(transforms[i].doc))
        .join(" → ")}`,
      rest.map((t) => t.doc.file),
    );
  }
}

/** Reports each file whose entity_id another file also holds. */
function reportDuplicateEntityIds(
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  report: Report,
): void {
  for (const [id, holders] of byEntityId) {
    if (holders.length > 1) {
      for (const doc of holders) {
        report(
          "duplicate-entity-id",
          doc,
          `entity_id ${id} is also in ${holders.length - 1} other file(s)`,
          holders.filter((h) => h !== doc).map((h) => h.file),
        );
      }
    }
  }
}

/** Orders findings by rule, as listed in `LINT_RULES`, then by file. */
function byRuleThenFile(a: LintFinding, b: LintFinding): number {
  return (
    LINT_RULES.indexOf(a.rule) - LINT_RULES.indexOf(b.rule) ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  );
}

/** Reports each transform, transform test or table file that fails its schema. */
function reportSchemaMismatches(docs: readonly Doc[], report: Report): void {
  for (const doc of docs) {
    if (
      !doc.schemaValid &&
      doc.model !== null &&
      LINTED_MODELS.has(doc.model)
    ) {
      report("schema", doc, `${doc.model} does not match its schema`);
    }
  }
}

export type TransformReads = {
  file: string;
  entity_id: string | null;
  name: string | null;
  /** Whether the transform's source is a query, the only kind Metabase can test. */
  queryTransform: boolean;
  /** The tables the transform reads, or null when the lint could not read them. */
  tables: TableName[] | null;
};

/** The tables each schema-valid transform in the folder reads, as `lint` finds them. */
export function transformReads({ folder }: LintOptions): TransformReads[] {
  const { docs } = loadDocs(folder);
  const readsOf = createReader(docs, indexByEntityId(docs));
  return validDocsOf(docs, "Transform").map((doc) => {
    const reads = readsOf(doc);
    return {
      file: doc.file,
      entity_id: doc.body.entity_id,
      name: doc.body.name,
      queryTransform: doc.body.source.type === "query",
      tables:
        reads.status === "read"
          ? reads.tables.map(({ schema, name }) => ({ schema, name }))
          : null,
    };
  });
}

/**
 * Checks the references between transforms, tables and transform tests in a
 * folder of representation files. Reads only the files; needs no Metabase.
 * Findings are grouped by rule, in the order of `LINT_RULES`, then by file.
 */
export function lint({ folder, defaultSchemas = {} }: LintOptions): LintResult {
  const { docs, unreadable } = loadDocs(folder);
  const findings: LintFinding[] = [];
  const report: Report = (rule, doc, message, related = []) =>
    findings.push({
      rule,
      severity: LINT_RULE_SEVERITY[rule],
      file: doc.file,
      entity: entityOf(doc),
      message,
      related,
    });

  const defaultSchemaOf: DefaultSchemaOf = (database) =>
    database !== null && Object.hasOwn(defaultSchemas, database)
      ? defaultSchemas[database]
      : undefined;

  for (const { file, reason } of unreadable) {
    report(
      "schema",
      { file, model: null, body: {}, schemaValid: false },
      `the file ${reason}`,
    );
  }
  reportSchemaMismatches(docs, report);

  const byEntityId = indexByEntityId(docs);
  reportDuplicateEntityIds(byEntityId, report);

  const readsOf = createReader(docs, byEntityId);
  const transforms = validDocsOf(docs, "Transform").map((doc) =>
    transformOf(doc, readsOf),
  );

  reportUnreadSourcesAndDuplicateTargets(transforms, defaultSchemaOf, report);

  reportCycles(transforms, defaultSchemaOf, report);

  const checkKnown = createUnknownTableCheck(
    docs,
    transforms,
    defaultSchemaOf,
    report,
  );
  checkReadTablesKnown(transforms, checkKnown);

  reportTestFindings(
    docs,
    byEntityId,
    transforms,
    checkKnown,
    defaultSchemaOf,
    report,
  );

  return {
    files: docs.length + unreadable.length,
    findings: findings.sort(byRuleThenFile),
  };
}
