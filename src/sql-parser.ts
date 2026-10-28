import { readFileSync } from "fs";
import { resolve } from "path";

import type { TableName } from "./tables.js";
import { isRecord } from "./values.js";
import { readVendorSources, VENDOR_DIR } from "./vendor-sources.js";

/** The tables a SQL text names, or why SQLGlot could not read it. */
export type ParsedTables =
  | { status: "read"; tables: TableName[] }
  | { status: "unread"; reason: string };

/** Metabase's SQL parser: SQLGlot, and Metabase's `sql_tools.py`, under Pyodide. */
export type SqlParser = {
  /**
   * The tables `sql` names, by `sql_tools.referenced_tables` in `dialect`
   * (SQLGlot's default when null): each once, sorted, without the catalog, as
   * Metabase reads them. Unread when SQLGlot raises, as on a parse error, a
   * statement nested deeper than Python's recursion limit, or an unknown
   * dialect.
   */
  referencedTables(sql: string, dialect: string | null): ParsedTables;
};

/**
 * Metabase's driver->dialect, `src/metabase/sql_tools/sqlglot/core.clj`: the
 * SQLGlot dialect of each driver that is not its own name. Null is SQLGlot's
 * default dialect.
 */
const DIALECTS: Readonly<Record<string, string | null>> = {
  "bigquery-cloud-sdk": "bigquery",
  sqlserver: "tsql",
  sparksql: "spark",
  "presto-jdbc": "presto",
  starburst: "trino",
  "druid-jdbc": "druid",
  vertica: null,
  h2: null,
};

/**
 * The SQLGlot dialect Metabase parses a database's SQL in, given its engine
 * (Metabase's driver name); SQLGlot's default dialect, null, when the engine
 * is unknown.
 */
export function dialectOf(engine: string | null): string | null {
  if (engine === null) {
    return null;
  }
  return Object.hasOwn(DIALECTS, engine) ? DIALECTS[engine] : engine;
}

// Calls Metabase's function and answers in JSON, so that no Python object
// crosses into JavaScript. An error keeps its first line: SQLGlot's next lines
// quote the SQL, with terminal escapes underlining where it stopped.
const READ_TABLES_PY = `
import json

import sql_tools


def lint_referenced_tables(sql, dialect):
    try:
        tables = json.loads(sql_tools.referenced_tables(sql, dialect))
    except Exception as e:
        lines = str(e).splitlines()
        return json.dumps({"error": type(e).__name__, "message": lines[0] if lines else ""})
    return json.dumps({"tables": [[schema, table] for _catalog, schema, table in tables]})
`;

const isTableTuple = (value: unknown): value is [string | null, string] =>
  Array.isArray(value) &&
  value.length === 2 &&
  (value[0] === null || typeof value[0] === "string") &&
  typeof value[1] === "string";

/** The answer of `lint_referenced_tables` as `ParsedTables`. */
function parsedTablesOf(answer: string): ParsedTables {
  const json: unknown = JSON.parse(answer);
  if (
    isRecord(json) &&
    Array.isArray(json.tables) &&
    json.tables.every(isTableTuple)
  ) {
    return {
      status: "read",
      tables: json.tables.map(([schema, name]) => ({ schema, name })),
    };
  }
  if (
    isRecord(json) &&
    typeof json.error === "string" &&
    typeof json.message === "string"
  ) {
    return { status: "unread", reason: `${json.error}: ${json.message}` };
  }
  throw new Error(`Unexpected answer from sql_tools: ${answer}`);
}

async function startSqlParser(): Promise<SqlParser> {
  // Imported here, so that a process that never parses SQL never loads it.
  const { loadPyodide } = await import("pyodide");
  // Python's output goes to stderr: the CLI's stdout carries findings only.
  const toStderr = (line: string) => process.stderr.write(`${line}\n`);
  const pyodide = await loadPyodide({ stdout: toStderr, stderr: toStderr });
  const { sqlglot } = readVendorSources();
  // unpackArchive refuses a Node Buffer: it takes only a plain typed array.
  pyodide.unpackArchive(
    new Uint8Array(readFileSync(resolve(VENDOR_DIR, sqlglot.wheel))),
    "wheel",
  );
  pyodide.FS.mkdirTree("/metabase");
  pyodide.FS.writeFile(
    "/metabase/sql_tools.py",
    readFileSync(resolve(VENDOR_DIR, "sql_tools.py")),
  );
  pyodide.runPython("import sys\nsys.path.insert(0, '/metabase')");
  pyodide.runPython(READ_TABLES_PY);
  const readTables: unknown = pyodide.globals.get("lint_referenced_tables");
  if (typeof readTables !== "function") {
    throw new Error("lint_referenced_tables is not defined");
  }
  return {
    referencedTables: (sql, dialect) => {
      // Pyodide passes JavaScript null as JsNull, and undefined as None, which
      // Metabase passes for the default dialect.
      const answer: unknown = readTables(sql, dialect ?? undefined);
      if (typeof answer !== "string") {
        throw new Error("lint_referenced_tables did not answer a string");
      }
      return parsedTablesOf(answer);
    },
  };
}

let started: Promise<SqlParser> | undefined;

/**
 * The SQL parser, loaded on the first call and shared by every later call in
 * the process. Loading takes about 1.5 seconds and 200 MB; each parse after
 * it is synchronous.
 */
export function loadSqlParser(): Promise<SqlParser> {
  started ??= startSqlParser();
  return started;
}

/** Whether the process has started loading the SQL parser. */
export function sqlParserStarted(): boolean {
  return started !== undefined;
}
