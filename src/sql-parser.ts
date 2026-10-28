import { readFileSync } from "fs";
import { resolve } from "path";

import type { TableName } from "./tables.js";
import { isRecord } from "./values.js";
import { readVendorSources, VENDOR_DIR } from "./vendor-sources.js";

/** Why SQLGlot could not read a SQL text. */
export type Unread = { status: "unread"; reason: string };

/** The tables a SQL text names, or why SQLGlot could not read it. */
export type ParsedTables = { status: "read"; tables: TableName[] } | Unread;

/**
 * A field spec of Metabase's `field_references`, with the parts the lint
 * reads. A real table's columns are `all_columns` of that table; a table
 * function's, and any spec SQLGlot gives that is not one of these, are
 * `unknown_columns`.
 */
export type FieldSpec =
  | {
      type: "single_column";
      column: string;
      alias: string | null;
      /** The specs the column may come from, innermost scope first. */
      sourceColumns: FieldSpec[][];
    }
  | { type: "all_columns"; table: TableName }
  | { type: "custom_field"; alias: string | null }
  | { type: "composite_field"; alias: string | null }
  | { type: "unknown_columns" };

/** What Metabase's `field_references` finds in a statement. */
export type FieldReferences = {
  /** The columns the statement reads, in any clause. */
  usedFields: FieldSpec[];
  /** The columns the outermost SELECT returns, in order. */
  returnedFields: FieldSpec[];
  /** Each name that qualifies a column but names no table or alias in its scope. */
  missingTableAliases: string[];
};

/**
 * A `replace_names` table replacement, as Metabase's transform tests give
 * it: a way a query names a table, and the table to name instead.
 */
export type TableReplacement = readonly [
  ReplacedTableKey,
  { db: null; schema: null; table: string },
];

/** A way a query names a table, as a `replace_names` key. */
export type ReplacedTableKey = { schema?: string; table: string };

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
  /**
   * The fields of `sql`, by `sql_tools.field_references` in `dialect`.
   * Unread when SQLGlot raises or cannot parse the statement.
   */
  fieldReferences(
    sql: string,
    dialect: string | null,
  ): { status: "read"; references: FieldReferences } | Unread;
  /**
   * `sql` with the tables of `replacements` replaced, by
   * `sql_tools.replace_names` in `dialect`. Unread when SQLGlot raises.
   */
  replaceNames(
    sql: string,
    replacements: readonly TableReplacement[],
    dialect: string | null,
  ): { status: "read"; sql: string } | Unread;
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

// Calls one of Metabase's functions and answers in JSON, so that no Python
// object crosses into JavaScript. An error keeps its first line: SQLGlot's
// next lines quote the SQL, with terminal escapes underlining where it
// stopped.
const CALL_SQL_TOOLS_PY = `
import json

import sql_tools


def lint_call_sql_tools(function, *args):
    try:
        answer = getattr(sql_tools, function)(*args)
    except Exception as e:
        lines = str(e).splitlines()
        return json.dumps({"error": type(e).__name__, "message": lines[0] if lines else ""})
    return json.dumps({"answer": answer})
`;

/** The answer of `lint_call_sql_tools`: the function's own answer, or why it raised. */
function answerOf(json: string): { status: "read"; answer: unknown } | Unread {
  const parsed: unknown = JSON.parse(json);
  if (isRecord(parsed) && "answer" in parsed) {
    return { status: "read", answer: parsed.answer };
  }
  if (
    isRecord(parsed) &&
    typeof parsed.error === "string" &&
    typeof parsed.message === "string"
  ) {
    return { status: "unread", reason: `${parsed.error}: ${parsed.message}` };
  }
  throw new Error(`Unexpected answer from sql_tools: ${json}`);
}

/** Thrown when a function of `sql_tools` answers in a shape it never gives. */
function unexpected(function_: string, answer: unknown): Error {
  return new Error(
    `Unexpected answer from sql_tools.${function_}: ${JSON.stringify(answer)}`,
  );
}

const isTableTuple = (
  value: unknown,
): value is [string | null, string | null, string] =>
  Array.isArray(value) &&
  value.length === 3 &&
  (value[0] === null || typeof value[0] === "string") &&
  (value[1] === null || typeof value[1] === "string") &&
  typeof value[2] === "string";

/** `referenced_tables`' answer, a JSON list of `[catalog, schema, table]`, without the catalog. */
function tablesOf(answer: unknown): TableName[] {
  const tables: unknown =
    typeof answer === "string" ? JSON.parse(answer) : undefined;
  if (!Array.isArray(tables) || !tables.every(isTableTuple)) {
    throw unexpected("referenced_tables", answer);
  }
  return tables.map(([, schema, name]) => ({ schema, name }));
}

const stringOrNullAt = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === "string" ? record[key] : null;

/** A field spec of `field_references`' JSON as a `FieldSpec`. */
function fieldSpecOf(value: unknown): FieldSpec {
  if (!isRecord(value)) {
    return { type: "unknown_columns" };
  }
  switch (value.type) {
    case "single_column":
      return typeof value.column === "string" &&
        Array.isArray(value.source_columns)
        ? {
            type: "single_column",
            column: value.column,
            alias: stringOrNullAt(value, "alias"),
            sourceColumns: value.source_columns.map((scope: unknown) =>
              Array.isArray(scope) ? scope.map(fieldSpecOf) : [],
            ),
          }
        : { type: "unknown_columns" };
    case "all_columns":
      return isRecord(value.table) && typeof value.table.table === "string"
        ? {
            type: "all_columns",
            table: {
              schema: stringOrNullAt(value.table, "schema"),
              name: value.table.table,
            },
          }
        : { type: "unknown_columns" };
    case "custom_field":
    case "composite_field":
      return { type: value.type, alias: stringOrNullAt(value, "alias") };
    default:
      return { type: "unknown_columns" };
  }
}

/** `field_references`' answer, or unread when it reports a syntax error. */
function fieldReferencesOf(
  answer: unknown,
): { status: "read"; references: FieldReferences } | Unread {
  const json: unknown =
    typeof answer === "string" ? JSON.parse(answer) : undefined;
  if (
    !isRecord(json) ||
    !Array.isArray(json.used_fields) ||
    !Array.isArray(json.returned_fields) ||
    !Array.isArray(json.errors) ||
    !json.errors.every(isRecord)
  ) {
    throw unexpected("field_references", answer);
  }
  if (json.errors.some((e) => e.type === "syntax_error")) {
    return { status: "unread", reason: "field_references could not parse it" };
  }
  return {
    status: "read",
    references: {
      usedFields: json.used_fields.map(fieldSpecOf),
      returnedFields: json.returned_fields.map(fieldSpecOf),
      missingTableAliases: json.errors.flatMap((e) =>
        e.type === "missing_table_alias" && typeof e.table === "string"
          ? [e.table]
          : [],
      ),
    },
  };
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
  pyodide.runPython(CALL_SQL_TOOLS_PY);
  const callPython: unknown = pyodide.globals.get("lint_call_sql_tools");
  if (typeof callPython !== "function") {
    throw new Error("lint_call_sql_tools is not defined");
  }
  // Pyodide passes JavaScript null as JsNull, and undefined as None, which
  // Metabase passes for the default dialect.
  const call = (function_: string, ...args: (string | null)[]) => {
    const json: unknown = callPython(
      function_,
      ...args.map((arg) => arg ?? undefined),
    );
    if (typeof json !== "string") {
      throw new Error("lint_call_sql_tools did not answer a string");
    }
    return answerOf(json);
  };
  return {
    referencedTables: (sql, dialect) => {
      const result = call("referenced_tables", sql, dialect);
      return result.status === "read"
        ? { status: "read", tables: tablesOf(result.answer) }
        : result;
    },
    fieldReferences: (sql, dialect) => {
      const result = call("field_references", sql, dialect);
      return result.status === "read"
        ? fieldReferencesOf(result.answer)
        : result;
    },
    // Metabase sends `columns` as null when it replaces only tables.
    replaceNames: (sql, replacements, dialect) => {
      const result = call(
        "replace_names",
        sql,
        JSON.stringify({ tables: replacements, columns: null }),
        dialect,
      );
      if (result.status === "unread") {
        return result;
      }
      if (typeof result.answer !== "string") {
        throw unexpected("replace_names", result.answer);
      }
      return { status: "read", sql: result.answer };
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
