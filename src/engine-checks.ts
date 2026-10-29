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
import type { Report } from "./findings.js";
import type { TestedTransform } from "./test-checks.js";

/** Whether `schema` is what Clojure's `str/blank?` calls blank: absent, empty or whitespace. */
const isBlank = (schema: string | null | undefined): boolean =>
  schema === undefined || schema === null || schema.trim() === "";

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

/**
 * The driver feature Metabase requires to run `transform`, with the name of
 * its kind; null for a source that is neither a query nor Python.
 */
function requiredFeature(transform: ValidDoc<"Transform">): {
  kind: "query" | "Python";
  feature: "transforms/table" | "transforms/python";
} | null {
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
