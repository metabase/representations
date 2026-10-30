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

/**
 * The text of a file's bytes, decoded as UTF-8; null when they are not valid
 * UTF-8.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-restricted-syntax -- decodes bytes only; reads no SQL
  } catch {
    return null;
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
  /**
   * The path of a map that holds the key, once its `<<` merges apply. A map
   * an alias repeats, or that a merge copies, lists its keys at each place.
   */
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

/** A key written a second time in one map, where it is written that time. */
export type DuplicateKey = {
  /** The key as written. */
  source: string;
  /** Counting from 1. */
  line: number;
  column: number;
};

/** A YAML document read as Metabase reads it. */
export type YamlDocument = {
  value: unknown;
  nonStringKeys: readonly NonStringKey[];
  /**
   * Each key a map holds more than once, at each occurrence after the first.
   * The value holds the last occurrence's value.
   */
  duplicateKeys: readonly DuplicateKey[];
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

/** The reason for an error, without its position. */
function reasonOf(error: YAMLError): string {
  return error.message.replace(/ at line \d+, column \d+:[\s\S]*$/, "");
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

/** A key of a map once its `<<` merges apply, as SnakeYAML reads the map. */
type MergedEntry = {
  /** The key as SnakeYAML reads it: an alias key resolved. */
  key: unknown;
  /** The key's text: a string key's value, or how a non-string key is written. */
  name: string;
  isString: boolean;
  /** Whether the key is not a string and the map has a string key of its text. */
  shadowed: boolean;
  value: unknown;
};

/**
 * Checks the parsed `doc` for what SnakeYAML refuses after parsing, and
 * names each non-string key by its text, which `toJS` then uses. Returns the
 * non-string keys, each once at the path of every map that holds it, merges
 * and aliases followed, and each key a map holds again. Drops a shadowed
 * key's pair after checking its value, and every pair of a key the map holds
 * again but the last, as SnakeYAML keeps the last value.
 */
function inspect(
  doc: Document.Parsed,
  text: string,
  lineCounter: LineCounter,
): { nonStringKeys: NonStringKey[]; duplicateKeys: DuplicateKey[] } {
  let collectionAliases = 0;
  const duplicateKeys: DuplicateKey[] = [];
  // Each map's keys once its merges apply, in the order SnakeYAML gives them
  // precedence: its own keys, then each merge source's in turn.
  const mergedEntries = new Map<YAMLMap, MergedEntry[]>();

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
  const resolved = (node: unknown): unknown =>
    isAlias(node) ? node.resolve(doc) : node;

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

  // Checks each node once, as written, and settles each map's keys.
  const check = (node: unknown, isKey: boolean): void => {
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
      node.items.forEach((item) => check(item, false));
    } else if (isMap(node)) {
      checkMap(node);
    }
  };

  const mergeSourcesOf = (value: unknown): YAMLMap[] => {
    const sources = resolved(value);
    return (isSeq(sources) ? sources.items : [value]).map((source) => {
      const map = resolved(source);
      return isMap(map)
        ? map
        : refuse("expected a mapping or list of mappings for merging", source);
    });
  };

  const checkMap = (map: YAMLMap): void => {
    const own: MergedEntry[] = [];
    const sources: YAMLMap[] = [];
    // Each pair whose key a later pair of the map holds again.
    const overridden = new Set<unknown>();
    const seen: { pair: unknown; key: unknown }[] = [];
    for (const pair of map.items) {
      const { key, value } = pair;
      if (isScalar(key) && typeof key.value === "symbol") {
        check(value, false);
        sources.push(...mergeSourcesOf(value));
        continue;
      }
      check(key, true);
      check(value, false);
      const readKey = resolved(key);
      const earlier = seen.find((s) => sameKey(s.key, readKey));
      if (earlier !== undefined) {
        overridden.add(earlier.pair);
        const position = lineCounter.linePos(
          isScalar(key) || isCollection(key) || isAlias(key)
            ? (key.range?.[0] ?? 0)
            : 0,
        );
        duplicateKeys.push({
          source: sourceOf(readKey),
          line: position.line,
          column: position.col,
        });
        const index = own.findIndex((e) => sameKey(e.key, readKey));
        own.splice(index, 1);
      }
      seen.push({ pair, key: readKey });
      const isString = isScalar(readKey) && typeof readKey.value === "string";
      own.push({
        key: readKey,
        name: isString ? String(readKey.value) : sourceOf(readKey),
        isString,
        shadowed: false,
        value,
      });
    }
    const merged = [...own];
    for (const source of sources) {
      for (const entry of mergedEntries.get(source) ?? []) {
        if (!merged.some((m) => sameKey(m.key, entry.key))) {
          merged.push(entry);
        }
      }
    }
    const stringNames = new Set(
      merged.flatMap((e) => (e.isString ? [e.name] : [])),
    );
    mergedEntries.set(
      map,
      merged.map((e) => ({
        ...e,
        shadowed: !e.isString && stringNames.has(e.name),
      })),
    );
    // Each own non-string key goes under its text; a shadowed one goes, and
    // so does a key the map holds again.
    map.items = map.items.filter((pair) => {
      if (overridden.has(pair)) {
        return false;
      }
      const readKey = resolved(pair.key);
      if (
        (isScalar(pair.key) && typeof pair.key.value === "symbol") ||
        (isScalar(readKey) && typeof readKey.value === "string")
      ) {
        if (isAlias(pair.key) && isScalar(readKey)) {
          pair.key = new Scalar(readKey.value);
        }
        return true;
      }
      const name = sourceOf(readKey);
      pair.key = new Scalar(name);
      return !stringNames.has(name);
    });
  };

  check(doc.contents, false);

  // Lists each map's non-string keys at every path the map's content takes.
  const nonStringKeys: NonStringKey[] = [];
  const path: (string | number)[] = [];
  const visiting = new Set<unknown>();
  const record = (node: unknown): void => {
    const target = resolved(node);
    if (visiting.has(target)) {
      return;
    }
    visiting.add(target);
    if (isSeq(target)) {
      target.items.forEach((item, index) => {
        path.push(index);
        record(item);
        path.pop();
      });
    } else if (isMap(target)) {
      for (const entry of mergedEntries.get(target) ?? []) {
        if (!entry.isString) {
          nonStringKeys.push({
            path: [...path],
            source: entry.name,
            shadowed: entry.shadowed,
          });
        }
        if (entry.shadowed) {
          continue;
        }
        path.push(entry.name);
        record(entry.value);
        path.pop();
      }
    }
    visiting.delete(target);
  };
  record(doc.contents);
  return { nonStringKeys, duplicateKeys };
}

/**
 * The YAML document in `text`, read as Metabase reads it (clj-yaml over
 * SnakeYAML: YAML 1.1 types, `<<` merge keys, SnakeYAML's limits). A map key
 * that SnakeYAML reads as something other than a string is in the value
 * under its text, and listed in `nonStringKeys`. A timestamp is a `Date`
 * with no time (`NaN`). A key a map holds again is in `duplicateKeys`, and
 * the map holds its last value, as SnakeYAML keeps it: Metabase's loader
 * leaves SnakeYAML's `allowDuplicateKeys` at its default, true
 * (`src/metabase/util/yaml.clj` `with-parse-defaults`). Throws
 * `YamlReadError` for any text SnakeYAML refuses, such as a merge source that
 * is not a map.
 */
export function readYaml(text: string): YamlDocument {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    version: "1.1",
    // Keeps SnakeYAML's types under a `%YAML 1.2` directive, as SnakeYAML does.
    schema: "yaml-1.1",
    customTags: snakeTags,
    // `inspect` finds keys a map holds again, as SnakeYAML compares keys.
    uniqueKeys: false,
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
  const { nonStringKeys, duplicateKeys } = inspect(doc, text, lineCounter);
  // SnakeYAML expands aliases by reference, with no limit beyond the one above.
  return {
    value: doc.toJS({ maxAliasCount: -1 }),
    nonStringKeys,
    duplicateKeys,
  };
}
