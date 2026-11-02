import { readFileSync } from "fs";
import { resolve } from "path";

import { LintSetupError } from "./settings.js";
import type { TableName } from "./tables.js";
import {
  errorMessage,
  isRecord,
  isStringArray,
  isStringOrNull,
  isUnknownArray,
} from "./values.js";
import { readVendorSources, VENDOR_DIR } from "./vendor-sources.js";

/** Why the lint could not read a SQL text. */
export type Unread = { status: "unread"; reason: string };

/** The tables a SQL text names, or why the lint could not read it. */
export type ParsedTables = { status: "read"; tables: TableName[] } | Unread;

/**
 * A field spec of Metabase's `field_references`, with the parts the lint
 * reads. `all_columns` names a table as the query names it: usually a real
 * table, but also a recursive CTE that refers to itself; `alias` is the
 * table's alias in the query, null when it has none. A table function's
 * columns are `unknown_columns`.
 */
export type FieldSpec =
  | {
      type: "single_column";
      column: string;
      alias: string | null;
      /** The specs the column may come from, innermost scope first. */
      sourceColumns: FieldSpec[][];
    }
  | { type: "all_columns"; table: TableName; alias: string | null }
  | { type: "custom_field"; alias: string | null }
  | { type: "composite_field"; alias: string | null }
  | { type: "unknown_columns" };

/** What Metabase's `field_references` finds in a statement. */
export type FieldReferences = {
  /** The columns the outermost SELECT returns, in order. */
  returnedFields: FieldSpec[];
};

/**
 * What SQLGlot's tree of a statement shows and `field_references` does not
 * say, as the lint reads it.
 */
export type QueryShape = {
  /** Whether an outermost SELECT returns `*` or `table.*`. */
  returnsStar: boolean;
};

/**
 * Metabase's SQL parser: SQLGlot, and Metabase's `sql_tools.py`, under
 * Pyodide.
 */
export type SqlParser = {
  /**
   * The tables `sql` names, by `sql_tools.referenced_tables` in `dialect`
   * (SQLGlot's default when null), as Metabase reads them: sorted by
   * catalog, schema and name, then the catalog dropped. Two tables that differ
   * only in their catalog come twice. Unread when SQLGlot raises, as on a
   * parse error, a statement nested deeper than Python's recursion limit, or
   * an unknown dialect.
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
   * The shape of `sql`'s one statement, parsed by SQLGlot in `dialect`.
   * Unread when SQLGlot raises, or `sql` holds more than one statement.
   */
  queryShape(
    sql: string,
    dialect: string | null,
  ): { status: "read"; shape: QueryShape } | Unread;
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
 * Metabase's driver->dialect, in the file and at the commit `dialects` in
 * `vendor/sources.json` records: the SQLGlot dialect of each driver that is
 * not its own name. Null is SQLGlot's default dialect.
 */
export const DIALECTS: Readonly<Record<string, string | null>> = {
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
 * (Metabase's driver name): null, SQLGlot's default, when the engine is null
 * or Metabase maps it to the default; an engine Metabase does not list is
 * the dialect's name, as in Metabase.
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
// where it stopped. A ParseError adds the line of SQL it names instead.
const CALL_SQL_TOOLS_PY = `
import json
import unicodedata

import sqlglot
import sql_tools
from sqlglot import exp

ANSWER_MARK = ${JSON.stringify(ANSWER_MARK)}


def lint_query_shape(sql, dialect):
    ast = sqlglot.parse_one(sql, read=dialect)
    # field_references reads such SQL as a syntax error.
    if isinstance(ast, exp.Block):
        return json.dumps({"unread": "the SQL holds more than one statement"})

    def outermost(node):
        if isinstance(node, exp.SetOperation):
            return outermost(node.this) + outermost(node.expression)
        if isinstance(node, exp.Subquery):
            return outermost(node.this)
        return [node] if isinstance(node, exp.Select) else []

    def is_star(e):
        return isinstance(e, exp.Star) or (isinstance(e, exp.Column) and isinstance(e.this, exp.Star))

    return json.dumps({
        "returns_star": any(is_star(e) for s in outermost(ast) for e in s.expressions),
    })


def escape_controls(text):
    # json.dumps writes a control or format character, or a line or paragraph
    # separator, as its JSON escape, such as \\u001b.
    return "".join(json.dumps(c)[1:-1] if unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") else c
                   for c in text)


def offending_line(e, sql):
    errors = getattr(e, "errors", None)
    line = errors[0].get("line") if errors and isinstance(errors[0], dict) else None
    # SQLGlot's tokenizer ends a line at CR LF, CR or LF, and at nothing else.
    lf, cr = chr(10), chr(13)
    sql_lines = sql.replace(cr + lf, lf).replace(cr, lf).split(lf) if isinstance(sql, str) else []
    if not isinstance(line, int) or not 1 <= line <= len(sql_lines):
        return ""
    text = sql_lines[line - 1].strip()
    return f" Line {line}: {text[:200]}{'...' if len(text) > 200 else ''}"


def lint_call_sql_tools(function, *args):
    try:
        answer = (lint_query_shape if function == "lint_query_shape" else getattr(sql_tools, function))(*args)
    except Exception as e:
        lines = str(e).splitlines()
        message = escape_controls((lines[0] if lines else "") + offending_line(e, args[0] if args else None))
        return ANSWER_MARK + json.dumps({"error": type(e).__name__, "message": message})
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

/**
 * Whether `unread` is SQLGlot's ParseError, the only failure Metabase's
 * `parse-error?` takes as SQL that cannot be parsed.
 */
export function isParseError(unread: Unread): boolean {
  return /^ParseError: /.test(unread.reason);
}

/**
 * Whether `unread` is SQLGlot failing to parse SQL in any way: a ParseError,
 * a TokenError, or a statement nested deeper than Python's recursion limit (a
 * RecursionError).
 */
export function isParseFailure(unread: Unread): boolean {
  return /^(ParseError|TokenError|RecursionError): /.test(unread.reason);
}

/** Unread: an answer whose shape the lint does not know. */
const UNEXPECTED_SHAPE: Unread = {
  status: "unread",
  reason: "the SQL parser answered in a shape the lint does not know",
};

/** The JSON that `answer`, a `sql_tools` answer, holds; undefined when it holds none. */
function jsonOf(answer: unknown): unknown {
  if (typeof answer !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(answer);
    // eslint-disable-next-line no-restricted-syntax -- wraps JSON.parse only
  } catch {
    return undefined;
  }
}

/**
 * A field spec of `field_references`' JSON as a `FieldSpec`; null when it is
 * not one. A type the lint does not know reads as columns it cannot place.
 */
function fieldSpecOf(spec: unknown): FieldSpec | null {
  if (!isRecord(spec) || typeof spec.type !== "string") {
    return null;
  }
  switch (spec.type) {
    case "single_column": {
      const { column, alias, source_columns: scopes } = spec;
      if (
        typeof column !== "string" ||
        !isStringOrNull(alias) ||
        !isUnknownArray(scopes)
      ) {
        return null;
      }
      const sourceColumns: FieldSpec[][] = [];
      for (const scope of scopes) {
        const specs = isUnknownArray(scope) ? scope.map(fieldSpecOf) : [null];
        if (specs.includes(null)) {
          return null;
        }
        sourceColumns.push(specs.filter((s) => s !== null));
      }
      return { type: spec.type, column, alias, sourceColumns };
    }
    case "all_columns": {
      const { table } = spec;
      return isRecord(table) &&
        typeof table.table === "string" &&
        (table.schema === undefined || typeof table.schema === "string") &&
        (table.table_alias === undefined ||
          typeof table.table_alias === "string")
        ? {
            type: spec.type,
            table: { schema: table.schema ?? null, name: table.table },
            alias: table.table_alias ?? null,
          }
        : null;
    }
    case "custom_field":
    case "composite_field":
      return isStringOrNull(spec.alias)
        ? { type: spec.type, alias: spec.alias }
        : null;
    default:
      return { type: "unknown_columns" };
  }
}

/** Each of `specs` as a `FieldSpec`; null when one is not a field spec. */
function fieldSpecsOf(specs: unknown): FieldSpec[] | null {
  if (!isUnknownArray(specs)) {
    return null;
  }
  const read = specs.map(fieldSpecOf);
  return read.includes(null) ? null : read.filter((s) => s !== null);
}

/** An error of `field_references`' JSON as a map; null when it is not one. */
function fieldErrorOf(error: unknown): Record<string, unknown> | null {
  // The syntax error of a query that is neither a SELECT nor a UNION, such
  // as an INTERSECT, comes as a list of [key, value] pairs.
  if (isUnknownArray(error)) {
    return error.every((pair) => isStringArray(pair) && pair.length === 2)
      ? Object.fromEntries(error.filter(isStringArray))
      : null;
  }
  return isRecord(error) && typeof error.type === "string" ? error : null;
}

/**
 * `field_references`' answer; unread when it reports a syntax error, or is
 * not in the shape `sql_tools` writes.
 */
export function fieldReferencesOf(
  answer: unknown,
): { status: "read"; references: FieldReferences } | Unread {
  const json = jsonOf(answer);
  if (!isRecord(json) || !isUnknownArray(json.errors)) {
    return UNEXPECTED_SHAPE;
  }
  const returnedFields = fieldSpecsOf(json.returned_fields);
  const errors = json.errors.map(fieldErrorOf);
  if (returnedFields === null || errors.includes(null)) {
    return UNEXPECTED_SHAPE;
  }
  // A missing_column error, an unqualified column that no table in its scope
  // can give, names no table's column; the column checks need none.
  if (errors.some((e) => e?.type === "syntax_error")) {
    return {
      status: "unread",
      reason:
        "Metabase reads columns only from a single SELECT or UNION statement, and could not read them from this SQL",
    };
  }
  return {
    status: "read",
    references: { returnedFields },
  };
}

/**
 * `referenced_tables`' answer, a list of [catalog, schema, table]; unread
 * when it is not in that shape.
 */
export function referencedTablesOf(answer: unknown): ParsedTables {
  const json = jsonOf(answer);
  const tables: TableName[] = [];
  if (!isUnknownArray(json)) {
    return UNEXPECTED_SHAPE;
  }
  for (const entry of json) {
    if (
      !isUnknownArray(entry) ||
      entry.length !== 3 ||
      !isStringOrNull(entry[0]) ||
      !isStringOrNull(entry[1]) ||
      typeof entry[2] !== "string"
    ) {
      return UNEXPECTED_SHAPE;
    }
    tables.push({ schema: entry[1], name: entry[2] });
  }
  return { status: "read", tables };
}

/**
 * `lint_query_shape`'s answer; unread when it says why it read no shape, as
 * for SQL of more than one statement, or is not in the shape it writes.
 */
export function queryShapeOf(
  answer: unknown,
): { status: "read"; shape: QueryShape } | Unread {
  const json = jsonOf(answer);
  if (isRecord(json) && typeof json.unread === "string") {
    return { status: "unread", reason: json.unread };
  }
  if (!isRecord(json) || typeof json.returns_star !== "boolean") {
    return UNEXPECTED_SHAPE;
  }
  return { status: "read", shape: { returnsStar: json.returns_star } };
}

/** The version of `pyodide`, an optional peer dependency, that `package.json` pins. */
const PYODIDE_VERSION = "314.0.7";

/** Whether `error`, from importing `pyodide`, says the package is not installed. */
const isPyodideMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ERR_MODULE_NOT_FOUND" &&
  errorMessage(error).includes("'pyodide'");

async function startSqlParser(): Promise<SqlParser> {
  // Imported here, so that a process that never parses SQL never loads it.
  const { loadPyodide } = await import("pyodide").catch((e: unknown) => {
    throw isPyodideMissing(e)
      ? new Error(
          `pyodide, an optional peer dependency, is not installed. Install pyodide@${PYODIDE_VERSION} where @metabase/representations is installed: npm install pyodide@${PYODIDE_VERSION}. Under npx, name both packages: npx -p @metabase/representations -p pyodide@${PYODIDE_VERSION} representations lint --experimental`,
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
    return answerOf(json);
  };
  return {
    referencedTables: (sql, dialect) => {
      const result = call("referenced_tables", sql, dialect);
      return result.status === "read"
        ? referencedTablesOf(result.answer)
        : result;
    },
    fieldReferences: (sql, dialect) => {
      const result = call("field_references", sql, dialect);
      return result.status === "read"
        ? fieldReferencesOf(result.answer)
        : result;
    },
    queryShape: (sql, dialect) => {
      const result = call("lint_query_shape", sql, dialect);
      return result.status === "read" ? queryShapeOf(result.answer) : result;
    },
  };
}

let started: Promise<SqlParser> | undefined;

/**
 * The SQL parser, loaded on the first call and shared by every later call in
 * the process; each parse after loading is synchronous. Rejects with a
 * `LintSetupError` when the parser cannot start, as when `pyodide`, an
 * optional peer dependency, or a vendored file is missing. A failed start is
 * not kept: the next call starts the parser again.
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

/**
 * `never` for a type that may be a promise (a promise, a union with one,
 * `unknown` or `any`), so that a function returning one is refused.
 */
type NotPromise<T> = unknown extends T
  ? never
  : [Extract<T, PromiseLike<unknown>>] extends [never]
    ? unknown
    : never;

/** Thrown by each function of `UNLOADED_SQL_PARSER`. */
class SqlParserUnloaded extends Error {}

const unloaded = (): never => {
  throw new SqlParserUnloaded();
};

/** Stands in for the parser until it loads, and throws on any call. */
const UNLOADED_SQL_PARSER: SqlParser = {
  referencedTables: unloaded,
  fieldReferences: unloaded,
  queryShape: unloaded,
};

/**
 * `use`'s answer, given the SQL parser, which loads only if `use` calls it.
 * Until the parser starts loading, `use` runs with a parser that throws on
 * any call; if it called one, `use` runs again with the loaded parser. So
 * `use` must be synchronous, must have no effect besides its answer, and
 * must not catch the parser's throw. Its type refuses an answer that is a
 * promise.
 */
export async function withSqlParser<T>(
  use: (parser: SqlParser) => T & NotPromise<T>,
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
