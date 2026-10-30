import type { EngineOf } from "./databases.js";
import {
  displayName,
  type Doc,
  isPythonSource,
  isQuerySource,
  queryDatabaseOf,
  targetDatabaseOf,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import { engineFacts } from "./engines.js";
import type { SourceFinder } from "./query-sources.js";
import type { Report } from "./findings.js";
import type { TestedTransform } from "./test-checks.js";
import { CONFIG_FILE } from "./settings.js";
import { isJavaBlank, isRecord, stringOrNull } from "./values.js";

/** Whether `schema` is what Clojure's `str/blank?` calls blank: absent, empty or Java whitespace. */
const isBlank = (schema: string | null | undefined): boolean =>
  schema === undefined || schema === null || isJavaBlank(schema);

/**
 * Reports each transform whose target names no schema, or a blank one, on a
 * database whose engine has schemas. Metabase's API refuses such a transform;
 * an import accepts it. A transform with no target database has nothing to
 * check.
 */
export function reportMissingTargetSchemas(
  docs: readonly Doc[],
  engineOf: EngineOf,
  report: Report,
): void {
  for (const transform of validDocsOf(docs, "Transform")) {
    const database = targetDatabaseOf(transform);
    if (database === null) {
      continue;
    }
    const engine = engineOf(database);
    if (
      engineFacts(engine)?.schemas === true &&
      isBlank(transform.body.target.schema)
    ) {
      report(
        "missing-target-schema",
        transform,
        `the target names no schema; Metabase requires one for database ${database}, whose engine ${engine} has schemas`,
      );
    }
  }
}

/** The driver feature Metabase requires to run a kind of transform. */
export type RequiredFeature =
  | { kind: "query"; feature: "transforms/table" }
  | { kind: "Python"; feature: "transforms/python" };

/**
 * The driver feature Metabase requires to run `transform`; null for a source
 * that is neither a query nor Python.
 */
function requiredFeature(
  transform: ValidDoc<"Transform">,
): RequiredFeature | null {
  const { source } = transform.body;
  if (isPythonSource(source)) {
    return { kind: "Python", feature: "transforms/python" };
  }
  return isQuerySource(source)
    ? { kind: "query", feature: "transforms/table" }
    : null;
}

/**
 * Reports each query or Python transform whose target database's engine
 * cannot run that kind of transform. Metabase's API refuses such a transform;
 * an import accepts it. A transform with no target database has nothing to
 * check.
 */
export function reportUnsupportedTransformEngines(
  docs: readonly Doc[],
  engineOf: EngineOf,
  report: Report,
): void {
  for (const transform of validDocsOf(docs, "Transform")) {
    const need = requiredFeature(transform);
    const database = targetDatabaseOf(transform);
    if (database === null) {
      continue;
    }
    const engine = engineOf(database);
    const features = engineFacts(engine);
    if (need !== null && features !== null && !features[need.feature]) {
      report(
        "unsupported-transform-engine",
        transform,
        `Metabase cannot run a ${need.kind} transform on database ${database}: its engine ${engine} lacks the driver feature ${need.feature}`,
      );
    }
  }
}

/**
 * Reports each test of a query transform whose query's database's engine
 * cannot run transform tests; Metabase refuses every run of it.
 */
export function reportUntestableEngines(
  tested: readonly TestedTransform[],
  engineOf: EngineOf,
  report: Report,
): void {
  for (const { test, transform } of tested) {
    const database = queryDatabaseOf(transform.doc);
    const engine = engineOf(database);
    if (engineFacts(engine)?.["transforms/testing"] === false) {
      report(
        "untestable-engine",
        test,
        `Metabase cannot run this test: transform ${displayName(transform.doc)} reads database ${database}, whose engine ${engine} lacks the driver feature transforms/testing`,
        [transform.doc.file],
      );
    }
  }
}

/** The database a Card's query runs on, or null when it names none. */
function cardDatabaseOf(card: Doc): string | null {
  const query = card.body.dataset_query;
  return isRecord(query) ? stringOrNull(query.database) : null;
}

/**
 * The databases `doc`, a transform or a Card, writes to or reads, each once:
 * a transform's target database (`targetDatabaseOf`) and its Python source
 * tables' databases, a Card's query's database, and the databases of the
 * tables and native queries either names.
 */
function databasesOf(doc: Doc, findSources: SourceFinder): string[] {
  const named: (string | null)[] = [];
  const transform = validDocsOf([doc], "Transform")[0];
  if (transform !== undefined) {
    named.push(targetDatabaseOf(transform));
    const { source } = transform.body;
    if (isPythonSource(source)) {
      for (const table of source["source-tables"]) {
        named.push(table.table_id?.[0] ?? table.database_id);
      }
    }
  } else {
    named.push(cardDatabaseOf(doc));
  }
  const sources = findSources(doc.body, doc.model);
  named.push(
    ...sources.tables.map((t) => t.database),
    ...sources.natives.map((n) => n.database),
  );
  return [...new Set(named.filter((d) => d !== null))];
}

/**
 * Warns once on each database a transform or a Card writes to or reads
 * (`databasesOf`) that has no engine the lint knows: no Database file or
 * settings file names one, or the one named is not in the lint's driver
 * table. The checks that depend on the engine then give no finding for it.
 * A remote-sync repository holds no Database file, so there `CONFIG_FILE`
 * gives the engines.
 */
export function reportUnknownEngines(
  docs: readonly Doc[],
  engineOf: EngineOf,
  findSources: SourceFinder,
  report: Report,
): void {
  const subjects = [
    ...validDocsOf(docs, "Transform"),
    ...docs.filter((doc) => doc.model === "Card"),
  ];
  for (const doc of subjects) {
    for (const database of databasesOf(doc, findSources)) {
      const engine = engineOf(database);
      if (engineFacts(engine) !== null) {
        continue;
      }
      report(
        "unknown-engine",
        doc,
        engine === null
          ? `no Database file or ${CONFIG_FILE} names the engine of database ${database}, so the checks that depend on it do not run. Give the database's driver name under "engines" in ${CONFIG_FILE}`
          : `the engine ${engine} of database ${database} is not in the lint's table of Metabase's drivers, as a third-party or newer driver is not, so the checks that depend on it do not run. Check the driver name`,
      );
    }
  }
}
