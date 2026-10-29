import {
  type Document,
  isAlias,
  isCollection,
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  Scalar,
  type YAMLError,
  type YAMLMap,
} from "yaml";

import { sameKey, snakeTags } from "./yaml-scalars.js";

/**
 * A YAML text that Metabase would refuse to read. `reason` says why;
 * `line` and `column` count from 1.
 */
export class YamlReadError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${reason} (${line}:${column})`);
    this.name = "YamlReadError";
  }
}

/** Where a node is in a value: map keys and list indexes, from the root. */
export type YamlPath = readonly (string | number)[];

/**
 * A map key that SnakeYAML reads as something other than a string: a plain
 * `1`, `yes`, `~` or date, or a map or list. A string-keyed lookup in
 * Metabase never finds it.
 */
export type NonStringKey = {
  /** The path of the map that holds the key. */
  path: YamlPath;
  /** The key as written. */
  source: string;
  /**
   * Whether the same map has a string key written the same way, such as
   * `'1':` beside `1:`. The map then holds that string key's value, and this
   * key is not in it; otherwise the map holds this key's value under
   * `source`.
   */
  shadowed: boolean;
};

/** A YAML document read as Metabase reads it. */
export type YamlDocument = {
  value: unknown;
  nonStringKeys: readonly NonStringKey[];
};

// SnakeYAML's `LoaderOptions` defaults, which clj-yaml keeps. Metabase's
// nesting limit of 10000 is not checked: the parser runs out of stack first.
const CODE_POINT_LIMIT = 3_145_728;
const MAX_ALIASES_FOR_COLLECTIONS = 50;
const BYTE_ORDER_MARK = "\uFEFF";

/**
 * The yaml library warns where SnakeYAML refuses: an unknown tag, or a
 * tag for the wrong kind of node.
 */
const REFUSED_WARNINGS = new Set(["TAG_RESOLVE_FAILED", "BAD_COLLECTION_TYPE"]);

/** The reason for an error; a duplicate key keeps js-yaml's wording for `validate-schema` users. */
function reasonOf(error: YAMLError): string {
  return error.code === "DUPLICATE_KEY"
    ? "duplicated mapping key"
    : error.message.replace(/ at line \d+, column \d+:[\s\S]*$/, "");
}

function readError(error: YAMLError): YamlReadError {
  const position = error.linePos?.[0] ?? { line: 1, col: 1 };
  return new YamlReadError(reasonOf(error), position.line, position.col);
}

/**
 * The first refusal among the yaml library's findings. Beyond its errors,
 * SnakeYAML refuses an unknown tag and a `%YAML` major version other than 1,
 * which the library only warns about.
 */
function refusalOf(doc: Document.Parsed): YamlReadError | null {
  const [error] = doc.errors;
  if (error !== undefined) {
    return readError(error);
  }
  for (const warning of doc.warnings) {
    if (REFUSED_WARNINGS.has(warning.code)) {
      return readError(warning);
    }
    const version = /^Unsupported YAML version (\d+)\./.exec(warning.message);
    if (version !== null && version[1] !== "1") {
      const { line, col } = warning.linePos?.[0] ?? { line: 1, col: 1 };
      return new YamlReadError(
        "found incompatible YAML document (version 1.* is required)",
        line,
        col,
      );
    }
  }
  return null;
}

/**
 * Where SnakeYAML's scanner stands when it last checks the code-point limit:
 * after the last token, and after the spaces and line breaks that follow it
 * when that token is a plain or block scalar.
 */
function scannedEnd(doc: Document.Parsed, text: string): number {
  let node: unknown = doc.contents;
  while (isCollection(node) && !node.flow && node.items.length > 0) {
    const last: unknown = node.items[node.items.length - 1];
    node = isPair(last) ? (last.value ?? last.key) : last;
  }
  if (!isScalar(node) && !isCollection(node) && !isAlias(node)) {
    return 0;
  }
  const end = node.range?.[1] ?? 0;
  const scansOn =
    isScalar(node) &&
    node.source !== "" &&
    (node.type === Scalar.PLAIN ||
      node.type === Scalar.BLOCK_LITERAL ||
      node.type === Scalar.BLOCK_FOLDED);
  const nextToken = text.slice(end).search(/[^ \t\r\n]/);
  return !scansOn ? end : nextToken === -1 ? text.length : end + nextToken;
}

/** The number of code points in `text` before `end`, not counting a byte order mark. */
function codePointsBefore(text: string, end: number): number {
  let count = 0;
  for (const _codePoint of text.slice(
    text.startsWith(BYTE_ORDER_MARK) ? 1 : 0,
    end,
  )) {
    count++;
  }
  return count;
}

/**
 * Checks the parsed `doc` for what SnakeYAML refuses after parsing, and
 * names each non-string key by its text, which `toJS` then uses. Returns the
 * non-string keys. Drops a shadowed key's pair after checking its value.
 */
function inspect(
  doc: Document.Parsed,
  text: string,
  lineCounter: LineCounter,
): NonStringKey[] {
  const nonStringKeys: NonStringKey[] = [];
  const path: (string | number)[] = [];
  let collectionAliases = 0;

  const refuse = (reason: string, node: unknown): never => {
    const offset =
      isScalar(node) || isCollection(node) || isAlias(node)
        ? (node.range?.[0] ?? 0)
        : 0;
    const { line, col } = lineCounter.linePos(offset);
    throw new YamlReadError(reason, line, col);
  };
  const sourceOf = (node: unknown): string => {
    const range = isScalar(node) || isCollection(node) ? node.range : undefined;
    return range ? text.slice(range[0], range[1]) : String(node);
  };

  const checkScalar = (node: Scalar, isKey: boolean): void => {
    if (!isKey && node.type === Scalar.PLAIN && node.source === "<<") {
      refuse("<< is a merge key and cannot be a value", node);
    }
    if (node.type === Scalar.QUOTE_DOUBLE) {
      // YAML 1.2 added these two escapes; SnakeYAML refuses them.
      const escape = /\\(.)/gs;
      for (const [, escaped] of sourceOf(node).matchAll(escape)) {
        if (escaped === "/" || escaped === "\t") {
          refuse(
            `the escape \\${escaped === "/" ? "/" : "<TAB>"} is not YAML 1.1`,
            node,
          );
        }
      }
    }
  };

  const walk = (node: unknown, isKey: boolean): void => {
    if (isAlias(node)) {
      if (
        isCollection(node.resolve(doc)) &&
        ++collectionAliases > MAX_ALIASES_FOR_COLLECTIONS
      ) {
        refuse(
          `the document has more than ${MAX_ALIASES_FOR_COLLECTIONS} aliases to a map or list`,
          node,
        );
      }
      return;
    }
    if (isScalar(node)) {
      checkScalar(node, isKey);
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => {
        path.push(index);
        walk(item, false);
        path.pop();
      });
    } else if (isMap(node)) {
      walkMap(node);
    }
  };

  const walkMap = (map: YAMLMap): void => {
    const stringKeys = new Set(
      map.items.flatMap(({ key }) =>
        isScalar(key) && typeof key.value === "string" ? [key.value] : [],
      ),
    );
    map.items = map.items.filter((pair) => {
      const { key, value } = pair;
      if (isScalar(key) && typeof key.value === "symbol") {
        // A `<<` merge key: the maps it merges count as this map.
        for (const source of isSeq(value) ? value.items : [value]) {
          if (isMap(source)) {
            walkMap(source);
          } else {
            walk(source, false);
          }
        }
        return true;
      }
      walk(key, true);
      if (isScalar(key) && typeof key.value === "string") {
        path.push(key.value);
        walk(value, false);
        path.pop();
        return true;
      }
      const source = sourceOf(key);
      const shadowed = stringKeys.has(source);
      nonStringKeys.push({ path: [...path], source, shadowed });
      path.push(source);
      walk(value, false);
      path.pop();
      pair.key = new Scalar(source);
      return !shadowed;
    });
  };

  walk(doc.contents, false);
  return nonStringKeys;
}

/**
 * The YAML document in `text`, read as Metabase reads it (clj-yaml over
 * SnakeYAML: YAML 1.1 types, `<<` merge keys, SnakeYAML's limits). A map key
 * that SnakeYAML reads as something other than a string is in the value
 * under its text, and listed in `nonStringKeys`. A timestamp is a `Date`
 * with no time (`NaN`). Throws `YamlReadError` for any text SnakeYAML
 * refuses, and for a duplicate key, which SnakeYAML accepts with the last
 * value.
 */
export function readYaml(text: string): YamlDocument {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    version: "1.1",
    // Keeps SnakeYAML's types under a `%YAML 1.2` directive, as SnakeYAML does.
    schema: "yaml-1.1",
    customTags: snakeTags,
    uniqueKeys: sameKey,
    // "silent" would also drop the error for a second document.
    logLevel: "error",
  });
  const refusal = refusalOf(doc);
  if (refusal !== null) {
    throw refusal;
  }
  if (codePointsBefore(text, scannedEnd(doc, text)) > CODE_POINT_LIMIT) {
    throw new YamlReadError(
      `the document exceeds the limit of ${CODE_POINT_LIMIT} code points`,
      1,
      1,
    );
  }
  const nonStringKeys = inspect(doc, text, lineCounter);
  // SnakeYAML expands aliases by reference, with no limit beyond the one above.
  return { value: doc.toJS({ maxAliasCount: -1 }), nonStringKeys };
}
