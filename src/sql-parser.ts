import { readFileSync } from "fs";
import { resolve } from "path";

import { LintSetupError } from "./settings.js";
import type { TableName } from "./tables.js";
import { errorMessage, isRecord } from "./values.js";
import { readVendorSources, VENDOR_DIR } from "./vendor-sources.js";

/** Why SQLGlot could not read a SQL text. */
export type Unread = { status: "unread"; reason: string };

/** The tables a SQL text names, or why SQLGlot could not read it. */
export type ParsedTables = { status: "read"; tables: TableName[] } | Unread;

/**
 * A field spec of Metabase's `field_references`, with the parts the lint
 * reads. A real table's columns are `all_columns` of that table; a table
 * function's are `unknown_columns`.
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

/**
 * Metabase's SQL parser: SQLGlot, and Metabase's `sql_tools.py`, under
 * Pyodide.
 */
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

/** `parse`, which answers each distinct SQL, in each dialect, once. */
export function cacheBySql<T extends object>(
  parse: (sql: string, dialect: string | null) => T,
): (sql: string, dialect: string | null) => T {
  const answers = new Map<string, T>();
  return (sql, dialect) => {
    const key = JSON.stringify([dialect, sql]);
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = parse(sql, dialect);
      answers.set(key, answer);
    }
    return answer;
  };
}

/**
 * Metabase's driver->dialect, `src/metabase/sql_tools/sqlglot/core.clj:27-48`
 * at Metabase commit `32ae44fec4af`: the SQLGlot dialect of each driver that
 * is not its own name. Null is SQLGlot's default dialect.
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

// Pyodide 314.0.7 garbles an ASCII-only string of 64 or more characters held
// above 2 GiB of its memory on its way to JavaScript; a string with a
// non-ASCII character takes a conversion that does not. json.dumps escapes
// every non-ASCII character, so the mark occurs only where the wrapper puts
// it. A character below U+0100 keeps Python's string at one byte per
// character.
const ANSWER_MARK = "\u00b6";

// Calls one of Metabase's functions and answers in JSON after ANSWER_MARK, so
// that no Python object crosses into JavaScript. An error keeps its first
// line: SQLGlot's next lines quote the SQL, with terminal escapes underlining
// where it stopped.
const CALL_SQL_TOOLS_PY = `
import json

import sql_tools

ANSWER_MARK = ${JSON.stringify(ANSWER_MARK)}


def lint_call_sql_tools(function, *args):
    try:
        answer = getattr(sql_tools, function)(*args)
    except Exception as e:
        lines = str(e).splitlines()
        return ANSWER_MARK + json.dumps({"error": type(e).__name__, "message": lines[0] if lines else ""})
    return ANSWER_MARK + json.dumps({"answer": answer})
`;

/**
 * The answer of `lint_call_sql_tools`: the function's own answer, or why it
 * raised. Unread when the text does not start with `ANSWER_MARK`, or the rest
 * is not JSON, or not an answer.
 */
export function answerOf(
  text: string,
): { status: "read"; answer: unknown } | Unread {
  if (!text.startsWith(ANSWER_MARK)) {
    return {
      status: "unread",
      reason: "the SQL parser answered without its mark",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(ANSWER_MARK.length));
    // eslint-disable-next-line no-restricted-syntax -- wraps JSON.parse only
  } catch (e) {
    return {
      status: "unread",
      reason: `the SQL parser answered with text that is not JSON: ${errorMessage(e)}`,
    };
  }
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
  return {
    status: "unread",
    reason: "the SQL parser answered with JSON that is not an answer",
  };
}

/** A field spec as `sql_tools.field_references` writes it. */
type FieldSpecJson =
  | {
      type: "single_column";
      column: string;
      alias: string | null;
      source_columns: FieldSpecJson[][];
    }
  | { type: "all_columns"; table: { schema?: string; table: string } }
  | { type: "custom_field" | "composite_field"; alias: string | null }
  | { type: "unknown_columns" };

/** An error as `sql_tools.field_references` writes it. */
type FieldError = { type: string; table?: string };

/** A field spec of `field_references`' JSON as a `FieldSpec`. */
function fieldSpecOf(spec: FieldSpecJson): FieldSpec {
  switch (spec.type) {
    case "single_column":
      return {
        type: spec.type,
        column: spec.column,
        alias: spec.alias,
        sourceColumns: spec.source_columns.map((scope) =>
          scope.map(fieldSpecOf),
        ),
      };
    case "all_columns":
      return {
        type: spec.type,
        table: { schema: spec.table.schema ?? null, name: spec.table.table },
      };
    case "custom_field":
    case "composite_field":
      return { type: spec.type, alias: spec.alias };
    case "unknown_columns":
      return { type: spec.type };
  }
}

/** `field_references`' answer, or unread when it reports a syntax error. */
function fieldReferencesOf(
  answer: string,
): { status: "read"; references: FieldReferences } | Unread {
  const json = JSON.parse(answer) as {
    used_fields: FieldSpecJson[];
    returned_fields: FieldSpecJson[];
    errors: (FieldError | [string, string][])[];
  };
  // The syntax error of a query that is neither a SELECT nor a UNION, such
  // as an INTERSECT, comes as a list of [key, value] pairs.
  const errors = json.errors.map((e) =>
    Array.isArray(e) ? (Object.fromEntries(e) as FieldError) : e,
  );
  if (errors.some((e) => e.type === "syntax_error")) {
    return { status: "unread", reason: "field_references could not parse it" };
  }
  return {
    status: "read",
    references: {
      usedFields: json.used_fields.map(fieldSpecOf),
      returnedFields: json.returned_fields.map(fieldSpecOf),
      missingTableAliases: errors.flatMap((e) =>
        e.type === "missing_table_alias" && e.table !== undefined
          ? [e.table]
          : [],
      ),
    },
  };
}

/** The version of `pyodide`, an optional dependency, that `package.json` pins. */
const PYODIDE_VERSION = "314.0.7";

/** Whether `error`, from importing `pyodide`, says the package is not installed. */
const isPyodideMissing = (error: unknown): boolean =>
  isRecord(error) &&
  error.code === "ERR_MODULE_NOT_FOUND" &&
  errorMessage(error).includes("'pyodide'");

async function startSqlParser(): Promise<SqlParser> {
  // Imported here, so that a process that never parses SQL never loads it.
  const { loadPyodide } = await import("pyodide").catch((e: unknown) => {
    throw isPyodideMissing(e)
      ? new Error(
          `the optional package pyodide is not installed. Install it with: npm install pyodide@${PYODIDE_VERSION}`,
        )
      : e;
  });
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
    // Each function of sql_tools the lint calls answers a string.
    return answerOf(json) as { status: "read"; answer: string } | Unread;
  };
  return {
    referencedTables: (sql, dialect) => {
      const result = call("referenced_tables", sql, dialect);
      return result.status === "read"
        ? {
            status: "read",
            // A list of [catalog, schema, table].
            tables: (
              JSON.parse(result.answer) as [
                string | null,
                string | null,
                string,
              ][]
            ).map(([, schema, name]) => ({ schema, name })),
          }
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
      return result.status === "read"
        ? { status: "read", sql: result.answer }
        : result;
    },
  };
}

let started: Promise<SqlParser> | undefined;

/**
 * The SQL parser, loaded on the first call and shared by every later call in
 * the process; each parse after loading is synchronous. Rejects with a
 * `LintSetupError` when the parser cannot start, as when the optional
 * `pyodide` package or a vendored file is missing. A failed start is not
 * kept: the next call starts the parser again.
 */
export function loadSqlParser(): Promise<SqlParser> {
  started ??= startSqlParser().catch((e: unknown) => {
    started = undefined;
    throw new LintSetupError(
      `The SQL parser could not start: ${errorMessage(e)}`,
      { cause: e },
    );
  });
  return started;
}

/** Whether the SQL parser is loading or loaded in this process. */
export function sqlParserStarted(): boolean {
  return started !== undefined;
}

/** Thrown by each function of `UNLOADED_SQL_PARSER`. */
class SqlParserUnloaded extends Error {}

const unloaded = (): never => {
  throw new SqlParserUnloaded();
};

/** Stands in for the parser until it loads, and throws on any call. */
const UNLOADED_SQL_PARSER: SqlParser = {
  referencedTables: unloaded,
  fieldReferences: unloaded,
  replaceNames: unloaded,
};

/**
 * `use`'s answer, given the SQL parser, which loads only if `use` calls it.
 * Until the parser starts loading, `use` runs with a parser that throws on
 * any call; if it called one, `use` runs again with the loaded parser. So
 * `use` must have no effect besides its answer, and must not catch the
 * parser's throw.
 */
export async function withSqlParser<T>(
  use: (parser: SqlParser) => T,
): Promise<T> {
  if (!sqlParserStarted()) {
    try {
      return use(UNLOADED_SQL_PARSER);
      // eslint-disable-next-line no-restricted-syntax -- rethrows all but the stand-in's throw
    } catch (e) {
      if (!(e instanceof SqlParserUnloaded)) {
        throw e;
      }
    }
  }
  return use(await loadSqlParser());
}
