import { databasesOf, type EngineOf } from "./databases.js";
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
import { isJavaBlank } from "./values.js";

/** Whether `schema` is what Clojure's `str/blank?` calls blank: absent, empty or Java whitespace. */
const isBlank = (schema: string | null | undefined): boolean =>
  schema === undefined || schema === null || isJavaBlank(schema);

/**
 * Reports each transform whose target schema is blank, on any engine and
 * also when the target names no database (`blank-target-schema`), and each
 * whose target names no schema, or a null one, on a database whose engine has
 * schemas (`missing-target-schema`). Metabase's API and a pull both refuse a
 * blank schema on any engine. Its API refuses no schema on an engine with
 * schemas; a pull accepts it, and a run writes to the default schema.
 */
export function reportMissingTargetSchemas(
  docs: readonly Doc[],
  engineOf: EngineOf,
  report: Report,
): void {
  for (const transform of validDocsOf(docs, "Transform")) {
    const database = targetDatabaseOf(transform);
    const { schema } = transform.body.target;
    if (typeof schema === "string" && isJavaBlank(schema)) {
      report(
        "blank-target-schema",
        transform,
        `the target's schema is blank, which Metabase refuses on any database, both when its API saves the transform and when remote sync pulls it. Name the schema, or remove the key if ${database === null ? "the target's database" : `database ${database}`} has no schemas`,
      );
      continue;
    }
    if (database === null) {
      continue;
    }
    const engine = engineOf(database);
    if (engineFacts(engine)?.schemas === true && isBlank(schema)) {
      report(
        "missing-target-schema",
        transform,
        `the target names no schema, on database ${database}, whose engine ${engine} has schemas. A pull accepts it, and a run writes the table to the database's default schema, but Metabase's API refuses to save the transform. Name the schema`,
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

/**
 * Warns once for each transform or Card and each database it writes to or
 * reads (`databasesOf`) that has no engine the lint knows: the settings file
 * names none, or the one named is not in the lint's driver table. The checks
 * that depend on the engine then give no finding for it.
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
          ? `${CONFIG_FILE} names no engine for database ${database}, so the checks that depend on it do not run. Give the database's driver name under "engines" in ${CONFIG_FILE}`
          : `the lint does not know the engine ${engine} of database ${database}, as with a third-party or newer driver, so the checks that depend on it do not run. Check the driver name`,
      );
    }
  }
}
