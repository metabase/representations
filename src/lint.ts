import {
  displayName,
  type Doc,
  indexByEntityId,
  loadDocs,
  sourceTypeOf,
  validDocsOf,
} from "./documents.js";
import { cycles } from "./graph.js";
import {
  type DefaultSchema,
  inputCovers,
  tableKeys,
  type TableName,
} from "./input-match.js";
import { createReader, type Transform, transformOf } from "./reads.js";
import { tablesReadBySql } from "./sql-tables.js";
import { sameTable, tableLabel, type TableKey, upper } from "./tables.js";
import { stringOrNull } from "./values.js";

/** Every rule, in the order the lint's output groups its findings. */
export const LINT_RULES = [
  "schema",
  "duplicate-entity-id",
  "dangling-transform-id",
  "wrong-type-transform-id",
  "duplicate-target",
  "transform-cycle",
  "missing-input",
  "unused-input",
  "untestable-transform",
  "duplicate-input",
  "expectation-reads-other-table",
  "unknown-table",
  "input-match-undecided",
  "reads-not-checked",
] as const;

export type LintRule = (typeof LINT_RULES)[number];

export type LintSeverity = "error" | "warning";

export type LintEntity = {
  model: string | null;
  entity_id: string | null;
  name: string | null;
};

export type LintFinding = {
  rule: LintRule;
  severity: LintSeverity;
  file: string;
  entity: LintEntity;
  message: string;
  related: string[];
};

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

type TableCheck = (doc: Doc, table: TableKey) => void;

type Report = (
  rule: LintRule,
  severity: LintSeverity,
  doc: Doc,
  message: string,
  related?: string[],
) => void;

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
function readEdges(transforms: readonly Transform[]): Map<number, number[]> {
  const edges = new Map<number, number[]>();
  transforms.forEach((transform, i) => {
    if (transform.reads.status !== "read") {
      return;
    }
    const reads = transform.reads.tables;
    edges.set(
      i,
      transforms.flatMap((upstream, j) => {
        const target = upstream.target;
        return target !== null && reads.some((t) => sameTable(t, target))
          ? [j]
          : [];
      }),
    );
  });
  return edges;
}

/**
 * For each transform in turn: a warning when its sources could not be read,
 * then an error when another transform writes the same target.
 */
function reportUnreadSourcesAndDuplicateTargets(
  transforms: readonly Transform[],
  report: Report,
): void {
  for (const transform of transforms) {
    if (transform.reads.status === "unread") {
      report(
        "reads-not-checked",
        "warning",
        transform.doc,
        `could not find the tables this transform reads: ${transform.reads.reason}`,
      );
    }
    const clashes = transforms.filter(
      (other) =>
        other !== transform &&
        transform.target !== null &&
        other.target !== null &&
        sameTable(transform.target, other.target),
    );
    if (clashes.length > 0 && transform.target !== null) {
      report(
        "duplicate-target",
        "error",
        transform.doc,
        `target ${tableLabel(transform.target)} is also written by ${clashes.length} other transform(s)`,
        clashes.map((c) => c.doc.file),
      );
    }
  }
}

/** The tables a test supplies inputs for, in the database of the transform it tests. */
function testInputs(test: Doc, transform: Transform): TableKey[] {
  const database = stringOrNull(transform.doc.body.source_database_id);
  return (test.body.inputs ?? []).map((input: Record<string, any>) => ({
    database,
    schema: stringOrNull(input.table?.schema),
    name: String(input.table?.name),
  }));
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
 * For each valid transform test: an error when its transform_id names nothing
 * or names no Transform; otherwise, when its transform's sources were read,
 * the mismatches between those sources and the test's inputs.
 */
function reportTestFindings(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transforms: readonly Transform[],
  checkKnown: TableCheck,
  defaultSchemaOf: (database: string | null) => DefaultSchema,
  report: Report,
): void {
  const transformsById = new Map(
    transforms.map((t) => [stringOrNull(t.doc.body.entity_id), t]),
  );
  for (const test of validDocsOf(docs, "TransformTest")) {
    const transformId = String(test.body.transform_id);
    const holders = byEntityId.get(transformId) ?? [];
    if (holders.length === 0) {
      report(
        "dangling-transform-id",
        "error",
        test,
        `transform_id ${transformId} matches no entity`,
      );
      continue;
    }
    if (!holders.some((h) => h.model === "Transform")) {
      report(
        "wrong-type-transform-id",
        "error",
        test,
        `transform_id ${transformId} names a ${holders[0].model ?? "file with no model"}, not a Transform`,
        holders.map((h) => h.file),
      );
      continue;
    }
    const transform = transformsById.get(transformId);
    if (transform === undefined) {
      continue;
    }
    if (sourceTypeOf(transform.doc) !== "query") {
      report(
        "untestable-transform",
        "error",
        test,
        `transform ${displayName(transform.doc)} is not a query transform; Metabase tests only query transforms`,
        [transform.doc.file],
      );
      continue;
    }
    const defaultSchema = defaultSchemaOf(
      stringOrNull(transform.doc.body.source_database_id),
    );
    const inputs = testInputs(test, transform);
    reportDuplicateInputs(test, inputs, defaultSchema, report);
    reportExpectationReads(test, transform, inputs, defaultSchema, report);
    if (transform.reads.status !== "read") {
      continue;
    }
    reportInputMismatches(
      test,
      transform,
      transform.reads.tables,
      checkKnown,
      defaultSchema,
      report,
    );
  }
}

/**
 * Reports a test whose inputs a query cannot tell apart: the same table twice,
 * ignoring case, or once unqualified and once in the default schema.
 */
function reportDuplicateInputs(
  test: Doc,
  inputs: readonly TableKey[],
  defaultSchema: DefaultSchema,
  report: Report,
): void {
  const counts = new Map<string, number>();
  for (const key of inputs.flatMap((i) => tableKeys(i, defaultSchema))) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colliding = inputs.filter((i) =>
    tableKeys(i, defaultSchema).some((key) => (counts.get(key) ?? 0) > 1),
  );
  if (colliding.length > 0) {
    report(
      "duplicate-input",
      "error",
      test,
      `inputs stand in for the same table: ${colliding.map(tableLabel).join(", ")}`,
    );
  }
}

/**
 * Reports each table an expectation's SQL reads that is neither the
 * transform's target nor one of the test's inputs; an expectation may read
 * only those. SQL the scan cannot read gives a reads-not-checked warning.
 */
function reportExpectationReads(
  test: Doc,
  transform: Transform,
  inputs: readonly TableKey[],
  defaultSchema: DefaultSchema,
  report: Report,
): void {
  const allowed = [...inputs, ...(transform.target ? [transform.target] : [])];
  const keys = new Set(allowed.flatMap((t) => tableKeys(t, defaultSchema)));
  for (const expectation of test.body.expectations ?? []) {
    if (typeof expectation?.sql !== "string") {
      continue;
    }
    const name = String(expectation.name);
    const result = tablesReadBySql(expectation.sql);
    if (result.status === "unread") {
      report(
        "reads-not-checked",
        "warning",
        test,
        `could not find the tables expectation ${name} reads: ${result.reason}`,
      );
      continue;
    }
    for (const table of result.tables) {
      const key = tableKeys(table, defaultSchema)[0];
      if (keys.has(key)) {
        continue;
      }
      const undecided =
        table.schema === null &&
        allowed.some(
          (t) => t.schema !== null && t.name.toLowerCase() === key,
        ) &&
        defaultSchema === undefined;
      report(
        undecided ? "input-match-undecided" : "expectation-reads-other-table",
        undecided ? "warning" : "error",
        test,
        undecided
          ? `expectation ${name} reads ${tableLabel(table)}, which is this test's table only if its schema is the default schema of ${transform.target?.database ?? "its database"}; set it with --default-schema`
          : `expectation ${name} reads ${tableLabel(table)}, which is neither the transform's target nor an input of this test`,
        [transform.doc.file],
      );
    }
  }
}

/**
 * Matches the test's inputs to the tables the transform reads by Metabase's
 * rule (`inputCovers`). Reports each read with no input, each pair whose match
 * depends on an unknown default schema (counted as a match), then, input by
 * input, an unknown table and an input that covers no read.
 */
function reportInputMismatches(
  test: Doc,
  transform: Transform,
  reads: readonly TableKey[],
  checkKnown: TableCheck,
  defaultSchema: DefaultSchema,
  report: Report,
): void {
  const inputs = testInputs(test, transform);
  const transformName = displayName(transform.doc);
  const covers = (read: TableKey, input: TableKey) =>
    inputCovers(read, input, defaultSchema) !== "no-match";
  for (const read of reads) {
    const matches = inputs.map((input) =>
      inputCovers(read, input, defaultSchema),
    );
    if (matches.includes("match")) {
      continue;
    }
    const undecided = inputs.filter((_, i) => matches[i] === "undecided");
    for (const input of undecided) {
      report(
        "input-match-undecided",
        "warning",
        test,
        `input ${tableLabel(input)} stands in for ${tableLabel(read)}, which transform ${transformName} reads, only if ${input.schema} is the default schema of ${read.database ?? "its database"}; set it with --default-schema`,
        [transform.doc.file],
      );
    }
    if (undecided.length === 0) {
      report(
        "missing-input",
        "error",
        test,
        `no input for ${tableLabel(read)}, which transform ${transformName} reads`,
        [transform.doc.file],
      );
    }
  }
  for (const input of inputs) {
    checkKnown(test, input);
    if (!reads.some((read) => covers(read, input))) {
      report(
        "unused-input",
        "error",
        test,
        `input ${tableLabel(input)} is not read by transform ${transformName}`,
        [transform.doc.file],
      );
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
  report: Report,
): TableCheck {
  const tableDocs = validDocsOf(docs, "Table");
  const tableFileDatabases = new Set(
    tableDocs.map((d) => upper(stringOrNull(d.body.db_id))),
  );
  const knownTables: TableKey[] = [
    ...tableDocs.map((d) => ({
      database: stringOrNull(d.body.db_id),
      schema: stringOrNull(d.body.schema),
      name: String(d.body.name),
    })),
    ...transforms.flatMap((t) => (t.target === null ? [] : [t.target])),
  ];
  return (doc: Doc, table: TableKey) => {
    if (
      tableFileDatabases.has(upper(table.database)) &&
      !knownTables.some((k) => sameTable(k, table))
    ) {
      report(
        "unknown-table",
        "warning",
        doc,
        `table ${tableLabel(table)} is defined by no table file or transform target`,
      );
    }
  };
}

/** Reports each cycle among transforms, on its first member in file order. */
function reportCycles(transforms: readonly Transform[], report: Report): void {
  const edges = readEdges(transforms);
  for (const component of cycles(edges, transforms.length)) {
    const [first, ...rest] = component.map((i) => transforms[i]);
    report(
      "transform-cycle",
      "error",
      first.doc,
      `transforms read each other's targets: ${component
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
          "error",
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
      report("schema", "error", doc, `${doc.model} does not match its schema`);
    }
  }
}

export type TransformReads = {
  file: string;
  entity_id: string | null;
  name: string | null;
  /** The tables the transform reads, or null when the lint could not read them. */
  tables: TableName[] | null;
};

/** The tables each schema-valid transform in the folder reads, as `lint` finds them. */
export function transformReads({ folder }: LintOptions): TransformReads[] {
  const docs = loadDocs(folder);
  const readsOf = createReader(docs, indexByEntityId(docs));
  return validDocsOf(docs, "Transform").map((doc) => {
    const reads = readsOf(doc);
    return {
      file: doc.file,
      entity_id: stringOrNull(doc.body.entity_id),
      name: stringOrNull(doc.body.name),
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
  const docs = loadDocs(folder);
  const findings: LintFinding[] = [];
  const report: Report = (rule, severity, doc, message, related = []) =>
    findings.push({
      rule,
      severity,
      file: doc.file,
      entity: entityOf(doc),
      message,
      related,
    });

  reportSchemaMismatches(docs, report);

  const byEntityId = indexByEntityId(docs);
  reportDuplicateEntityIds(byEntityId, report);

  const readsOf = createReader(docs, byEntityId);
  const transforms = validDocsOf(docs, "Transform").map((doc) =>
    transformOf(doc, readsOf),
  );

  reportUnreadSourcesAndDuplicateTargets(transforms, report);

  reportCycles(transforms, report);

  const checkKnown = createUnknownTableCheck(docs, transforms, report);
  checkReadTablesKnown(transforms, checkKnown);

  const defaultSchemaOf = (database: string | null): DefaultSchema =>
    database !== null && Object.hasOwn(defaultSchemas, database)
      ? defaultSchemas[database]
      : undefined;
  reportTestFindings(
    docs,
    byEntityId,
    transforms,
    checkKnown,
    defaultSchemaOf,
    report,
  );

  return { files: docs.length, findings: findings.sort(byRuleThenFile) };
}
