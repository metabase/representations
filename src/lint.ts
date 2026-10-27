import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { resolve } from "path";

import {
  type DefaultSchema,
  inputCovers,
  tableKeys,
  type TableName,
} from "./input-match.js";
import { createSourceFinder, type NativeSql } from "./query-sources.js";
import { loadSchemas } from "./schemas.js";
import { type SqlTable, tablesReadBySql } from "./sql-tables.js";
import { getModel, IMPORT_PATHS, validateSchema } from "./validate-schema.js";

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

// Table files are not imported, so `validateSchema` does not check them.
const TABLE_PATHS = ["databases/**/tables/**/*.yaml"];

type Doc = {
  file: string;
  model: string | null;
  body: Record<string, any>;
  schemaValid: boolean;
};

type TableKey = {
  database: string | null;
  schema: string | null;
  name: string;
};

type Reads =
  | { status: "read"; tables: TableKey[] }
  | { status: "unread"; reason: string };

type Transform = {
  doc: Doc;
  target: TableKey | null;
  reads: Reads;
};

type TableCheck = (doc: Doc, table: TableKey) => void;

type Report = (
  rule: LintRule,
  severity: LintSeverity,
  doc: Doc,
  message: string,
  related?: string[],
) => void;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function entityOf(doc: Doc): LintEntity {
  return {
    model: doc.model,
    entity_id: stringOrNull(doc.body.entity_id),
    name: stringOrNull(doc.body.name),
  };
}

/** The documents of one model that match their schema. */
function validDocsOf(docs: Doc[], model: string): Doc[] {
  return docs.filter((d) => d.model === model && d.schemaValid);
}

/** The document's name, or its file when it has none. */
function displayName(doc: Doc): string {
  return stringOrNull(doc.body.name) ?? doc.file;
}

function upper(value: string | null): string | null {
  return value === null ? null : value.toUpperCase();
}

/** Whether two table names can denote the same table; a missing part matches any. */
function sameTable(a: TableKey, b: TableKey): boolean {
  const part = (x: string | null, y: string | null) =>
    x === null || y === null || upper(x) === upper(y);
  return (
    upper(a.name) === upper(b.name) &&
    part(a.schema, b.schema) &&
    part(a.database, b.database)
  );
}

function tableLabel(table: TableName): string {
  return table.schema === null ? table.name : `${table.schema}.${table.name}`;
}

function loadDocs(folder: string): Doc[] {
  const invalid = new Set(
    validateSchema({ folder })
      .results.filter((r) => r.status === "fail")
      .map((r) => r.file),
  );
  const docs: Doc[] = [];
  const files = new Set(
    globSync([...IMPORT_PATHS, ...TABLE_PATHS], { cwd: folder }),
  );
  for (const file of [...files].sort()) {
    let body: unknown;
    try {
      body = yaml.load(readFileSync(resolve(folder, file), "utf8"));
    } catch {
      continue;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      continue;
    }
    docs.push({
      file,
      model: stringOrNull(getModel(body)),
      body: body as Record<string, any>, // A YAML map, checked above.
      schemaValid: !invalid.has(file),
    });
  }
  return docs;
}

const SNIPPET_MODEL = "NativeQuerySnippet";
const MAX_SNIPPET_DEPTH = 8;

/** Pastes each `{{snippet: name}}` in, as Metabase does; null when a snippet is missing. */
function expandSnippets(
  sql: string,
  snippets: Map<string, string>,
  depth = 0,
): string | null {
  let missing = false;
  const expanded = sql.replace(
    /\{\{\s*snippet:\s*([^}]*?)\s*\}\}/gi,
    (_, name: string) => {
      const content = snippets.get(name);
      if (content === undefined) {
        missing = true;
        return "";
      }
      return content;
    },
  );
  if (missing) {
    return null;
  }
  if (/\{\{\s*snippet:/i.test(expanded)) {
    return depth < MAX_SNIPPET_DEPTH
      ? expandSnippets(expanded, snippets, depth + 1)
      : null;
  }
  return expanded;
}

/**
 * The tables of native queries, in order, after pasting their snippets in;
 * unread at the first query with a missing snippet or SQL the scan cannot read.
 */
function nativeReads(
  natives: NativeSql[],
  snippets: Map<string, string>,
): Reads {
  const tables: TableKey[] = [];
  for (const native of natives) {
    const sql = expandSnippets(native.sql, snippets);
    if (sql === null) {
      return {
        status: "unread",
        reason: "a snippet it uses is not in the folder",
      };
    }
    const result = tablesReadBySql(sql);
    if (result.status === "unread") {
      return result;
    }
    tables.push(
      ...result.tables.map((t: SqlTable) => ({
        database: native.database,
        ...t,
      })),
    );
  }
  return { status: "read", tables };
}

function pythonReads(body: Record<string, any>): Reads {
  const database = stringOrNull(body.source_database_id);
  const tables: TableKey[] = (body.source["source-tables"] ?? []).map(
    (t: Record<string, any>) =>
      Array.isArray(t.table_id)
        ? {
            database: t.table_id[0],
            schema: t.table_id[1],
            name: t.table_id[2],
          }
        : {
            database: stringOrNull(t.database_id) ?? database,
            schema: stringOrNull(t.schema),
            name: String(t.table),
          },
  );
  return { status: "read", tables };
}

/**
 * Returns a function giving the tables an entity reads: those its schema
 * types as tables, those its native SQL names, and the tables of each card,
 * metric, measure or segment it uses, followed to their own files.
 */
function createReader(docs: Doc[], byEntityId: Map<string, Doc[]>) {
  const findSources = createSourceFinder(loadSchemas());
  const snippets = new Map(
    docs
      .filter((d) => d.model === SNIPPET_MODEL)
      .map((d) => [String(d.body.name), String(d.body.content)]),
  );
  const memo = new Map<Doc, Reads>();

  const readsOf = (doc: Doc, visiting: Set<Doc>): Reads => {
    const known = memo.get(doc);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(doc)) {
      return {
        status: "unread",
        reason: `${doc.file} uses itself as a source`,
      };
    }
    if (doc.body.source?.type === "python") {
      return pythonReads(doc.body);
    }
    const sources = findSources(doc.body, doc.model ?? "");
    const tables: TableKey[] = [...sources.tables];
    const native = nativeReads(sources.natives, snippets);
    if (native.status === "unread") {
      return native;
    }
    tables.push(...native.tables);
    const inner = new Set([...visiting, doc]);
    for (const id of sources.entities) {
      const source = byEntityId.get(id)?.[0];
      if (source === undefined) {
        return {
          status: "unread",
          reason: `source ${id} is not in the folder`,
        };
      }
      if (source.model === SNIPPET_MODEL) {
        continue;
      }
      const reads = readsOf(source, inner);
      if (reads.status === "unread") {
        return {
          status: "unread",
          reason: `through ${source.file}: ${reads.reason}`,
        };
      }
      tables.push(...reads.tables);
    }
    const reads: Reads = { status: "read", tables };
    memo.set(doc, reads);
    return reads;
  };

  return (doc: Doc) => readsOf(doc, new Set());
}

function transformOf(doc: Doc, readsOf: (doc: Doc) => Reads): Transform {
  const database = stringOrNull(doc.body.source_database_id);
  const target = doc.body.target;
  return {
    doc,
    target:
      typeof target?.name === "string"
        ? {
            database: stringOrNull(target.database) ?? database,
            schema: stringOrNull(target.schema),
            name: target.name,
          }
        : null,
    reads: readsOf(doc),
  };
}

/**
 * For each transform whose sources were read, by index: the indexes of the
 * transforms whose target it reads.
 */
function readEdges(transforms: Transform[]): Map<number, number[]> {
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

/** The strongly connected components of size above one, or with a self-edge. */
function cycles(edges: Map<number, number[]>, size: number): number[][] {
  const index: number[] = new Array(size).fill(-1);
  const low: number[] = new Array(size).fill(0);
  const onStack: boolean[] = new Array(size).fill(false);
  const stack: number[] = [];
  const found: number[][] = [];
  let next = 0;

  const visit = (v: number) => {
    index[v] = low[v] = next++;
    stack.push(v);
    onStack[v] = true;
    for (const w of edges.get(v) ?? []) {
      if (index[w] === -1) {
        visit(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], index[w]);
      }
    }
    if (low[v] === index[v]) {
      const component: number[] = [];
      let w: number;
      do {
        w = stack.pop() as number; // The stack holds v, so it is not empty.
        onStack[w] = false;
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (edges.get(v) ?? []).includes(v)) {
        found.push(component.sort((a, b) => a - b));
      }
    }
  };

  for (let v = 0; v < size; v++) {
    if (index[v] === -1) {
      visit(v);
    }
  }
  return found;
}

/** Every document with an entity_id, keyed by it; several when the id is duplicated. */
function indexByEntityId(docs: Doc[]): Map<string, Doc[]> {
  const byEntityId = new Map<string, Doc[]>();
  for (const doc of docs) {
    const id = stringOrNull(doc.body.entity_id);
    if (id !== null) {
      byEntityId.set(id, [...(byEntityId.get(id) ?? []), doc]);
    }
  }
  return byEntityId;
}

/**
 * For each transform in turn: a warning when its sources could not be read,
 * then an error when another transform writes the same target.
 */
function reportUnreadSourcesAndDuplicateTargets(
  transforms: Transform[],
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
  transforms: Transform[],
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
  docs: Doc[],
  byEntityId: Map<string, Doc[]>,
  transforms: Transform[],
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
    if (transform.doc.body.source?.type !== "query") {
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
  inputs: TableKey[],
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
  inputs: TableKey[],
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
  reads: TableKey[],
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
  docs: Doc[],
  transforms: Transform[],
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
function reportCycles(transforms: Transform[], report: Report): void {
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
  byEntityId: Map<string, Doc[]>,
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
function reportSchemaMismatches(docs: Doc[], report: Report): void {
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
