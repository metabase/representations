import {
  type Document,
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  type Pair,
  parseDocument,
  Scalar,
  type YAMLError,
  YAMLMap,
  YAMLSeq,
} from "yaml";

import { keyBucket, sameKey, snakeTags } from "./yaml-scalars.js";

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
 * The text of a file's bytes, decoded as UTF-8: each invalid byte sequence
 * reads as U+FFFD, and a byte order mark stays. Java's `String` also reads
 * each invalid sequence as U+FFFD, but can divide the bytes into sequences
 * differently: `ED A0 80` is one U+FFFD in Java and three here.
 * `invalidUtf8` says whether there was an invalid byte sequence.
 */
export function decodeUtf8(bytes: Uint8Array): {
  text: string;
  invalidUtf8: boolean;
} {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      invalidUtf8: false,
    };
  } catch {
    return {
      text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes),
      invalidUtf8: true,
    };
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
  /**
   * Which value of the key SnakeYAML keeps: the last, or the first where
   * the map is only a `<<` merge source written in place, such as
   * `<<: {k: 1, k: 2}`.
   */
  keeps: "first" | "last";
};

/** A YAML document read as Metabase reads it. */
export type YamlDocument = {
  value: unknown;
  nonStringKeys: readonly NonStringKey[];
  /** Each key a map holds more than once, at each occurrence after the first. */
  duplicateKeys: readonly DuplicateKey[];
};

// SnakeYAML's `LoaderOptions` defaults, which clj-yaml keeps. Metabase's
// nesting limit of 10000 is not checked: the parser runs out of stack first.
const CODE_POINT_LIMIT = 3_145_728;
const MAX_ALIASES_FOR_COLLECTIONS = 50;

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
 * SnakeYAML refuses an unknown tag, a tag on the wrong kind of node, and a
 * `%YAML` major version other than 1, which the library only warns about.
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

/** The number of code points in `text` before `end`. */
function codePointsBefore(text: string, end: number): number {
  let count = 0;
  for (const _codePoint of text.slice(0, end)) {
    count++;
  }
  return count;
}

/** A key of a map once its `<<` merges apply, as SnakeYAML reads the map. */
type MergedEntry = {
  /** The key as SnakeYAML reads it: an alias key resolved. */
  key: unknown;
  /** The key node as written: an alias key not resolved. */
  writtenKey: unknown;
  /** The key's text: a string key's value, or how a non-string key is written. */
  name: string;
  isString: boolean;
  /** Whether the key is not a string and the map has a string key of its text. */
  shadowed: boolean;
  value: unknown;
};

/** Items found by their map key as SnakeYAML compares keys (`sameKey`). */
type KeyIndex<T extends { key: unknown }> = {
  /** The item last added whose key is one with `key`. */
  find: (key: unknown) => T | undefined;
  add: (item: T) => void;
};

// A map can hold hundreds of thousands of keys: a lookup must not compare a
// key with every other one.
function createKeyIndex<T extends { key: unknown }>(): KeyIndex<T> {
  const buckets = new Map<unknown, T[]>();
  return {
    find: (key) =>
      buckets.get(keyBucket(key))?.findLast((item) => sameKey(item.key, key)),
    add: (item) => {
      const bucket = keyBucket(item.key);
      const items = buckets.get(bucket);
      if (items === undefined) {
        buckets.set(bucket, [item]);
      } else {
        items.push(item);
      }
    },
  };
}

/**
 * Checks the parsed `doc` for what SnakeYAML refuses after parsing, and
 * builds its value as SnakeYAML constructs it. Returns the value, the
 * non-string keys, each once at the path of every map that holds it, merges
 * and aliases followed, and each key a map holds again.
 */
function inspect(
  doc: Document.Parsed,
  text: string,
  lineCounter: LineCounter,
): YamlDocument {
  let collectionAliases = 0;
  // Each key a map holds again, with that map.
  const duplicates: { map: YAMLMap; key: Omit<DuplicateKey, "keeps"> }[] = [];
  // Each pair whose key a later pair of its map holds again.
  const overridden = new Set<Pair>();

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
  // `Alias.resolve` walks the whole document on each call.
  const aliasTargets = new Map<unknown, unknown>();
  const resolved = (node: unknown): unknown => {
    if (!isAlias(node)) {
      return node;
    }
    if (!aliasTargets.has(node)) {
      aliasTargets.set(node, node.resolve(doc));
    }
    return aliasTargets.get(node);
  };
  const isMergePair = (pair: Pair): boolean =>
    isScalar(pair.key) && typeof pair.key.value === "symbol";

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

  // Checks each node once, as written, and finds the keys each map holds
  // again.
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
    const seen = createKeyIndex<{ pair: Pair; key: unknown }>();
    for (const pair of map.items) {
      const { key, value } = pair;
      if (isMergePair(pair)) {
        check(value, false);
        mergeSourcesOf(value);
        continue;
      }
      check(key, true);
      check(value, false);
      const readKey = resolved(key);
      const earlier = seen.find(readKey);
      if (earlier !== undefined) {
        overridden.add(earlier.pair);
        const position = lineCounter.linePos(
          isScalar(key) || isCollection(key) || isAlias(key)
            ? (key.range?.[0] ?? 0)
            : 0,
        );
        duplicates.push({
          map,
          key: {
            source: sourceOf(readKey),
            line: position.line,
            column: position.col,
          },
        });
      }
      seen.add({ pair, key: readKey });
    }
  };

  check(doc.contents, false);

  // SnakeYAML constructs each node once, in document order, a map's merges
  // first. Constructing a map flattens it: its earlier pairs of a key it
  // holds again go, then its `<<` merges apply. A merge source flattened
  // before gives its flattened keys; one not yet flattened, such as a map
  // written inline after `<<:`, gives its pairs as written, the first of a
  // key it holds again, and loses its own `<<` pairs.
  const flattened = new Map<YAMLMap, MergedEntry[]>();
  const constructed = new Set<unknown>();
  const strippedMerges = new Set<Pair>();

  const entryOf = (pair: Pair): MergedEntry => {
    const key = resolved(pair.key);
    const isString = isScalar(key) && typeof key.value === "string";
    return {
      key,
      writtenKey: pair.key,
      name: isString ? String(key.value) : sourceOf(key),
      isString,
      shadowed: false,
      value: pair.value,
    };
  };

  const flatten = (map: YAMLMap): MergedEntry[] => {
    const entries: MergedEntry[] = [];
    const slots = createKeyIndex<{ key: unknown; slot: number }>();
    const put = (entry: MergedEntry, replace: boolean): void => {
      const existing = slots.find(entry.key);
      if (existing === undefined) {
        slots.add({ key: entry.key, slot: entries.length });
        entries.push(entry);
      } else if (replace) {
        entries[existing.slot] = entry;
      }
    };
    const mergeInto = (source: YAMLMap, preferred: boolean): void => {
      for (const pair of source.items) {
        if (!isMergePair(pair)) {
          if (!preferred || !overridden.has(pair)) {
            construct(pair.key);
            put(entryOf(pair), preferred);
          }
          continue;
        }
        if (strippedMerges.has(pair)) {
          continue;
        }
        strippedMerges.add(pair);
        for (const merged of mergeSourcesOf(pair.value)) {
          const done = flattened.get(merged);
          if (done === undefined) {
            mergeInto(merged, false);
          } else {
            done.forEach((entry) => put(entry, false));
          }
        }
      }
    };
    mergeInto(map, true);
    const stringNames = new Set(
      entries.flatMap((e) => (e.isString ? [e.name] : [])),
    );
    return entries.map((e) => ({
      ...e,
      shadowed: !e.isString && stringNames.has(e.name),
    }));
  };

  const construct = (node: unknown): void => {
    const target = resolved(node);
    if (constructed.has(target)) {
      return;
    }
    constructed.add(target);
    if (isSeq(target)) {
      target.items.forEach(construct);
    } else if (isMap(target)) {
      const entries = flatten(target);
      flattened.set(target, entries);
      entries.forEach((entry) => construct(entry.value));
    }
  };
  construct(doc.contents);

  // Lists each map's non-string keys at every path the map's content takes.
  const nonStringKeys: NonStringKey[] = [];
  const path: (string | number)[] = [];
  const visiting = new Set<unknown>();
  // A document without aliases has fewer nodes than code points, so the
  // budget refuses only a document whose aliases expand past it.
  let visits = 0;
  // `inKey`: `node` is in a map key, which has no path; only its cycles
  // count.
  const record = (node: unknown, inKey: boolean): void => {
    if (++visits > CODE_POINT_LIMIT) {
      refuse(
        `the document's aliases expand to more than ${CODE_POINT_LIMIT} nodes`,
        node,
      );
    }
    const target = resolved(node);
    if (visiting.has(target)) {
      // SnakeYAML builds the cycle, and Metabase's conversion of it recurses
      // without end.
      refuse("an alias refers to a map or list that holds it", node);
    }
    visiting.add(target);
    if (isSeq(target)) {
      target.items.forEach((item, index) => {
        path.push(index);
        record(item, inKey);
        path.pop();
      });
    } else if (isMap(target)) {
      for (const entry of flattened.get(target) ?? []) {
        if (isCollection(entry.key)) {
          // SnakeYAML refuses a key that holds a map or list it is in.
          record(entry.writtenKey, true);
        }
        if (!entry.isString && !inKey) {
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
        record(entry.value, inKey);
        path.pop();
      }
    }
    visiting.delete(target);
  };
  record(doc.contents, false);

  // An alias gives the value its target gives, as SnakeYAML shares it.
  const values = new Map<unknown, unknown>();
  const valueOf = (node: unknown): unknown => {
    const target = resolved(node);
    if (values.has(target)) {
      return values.get(target);
    }
    if (isScalar(target)) {
      return target.value;
    }
    const entries = isMap(target) ? flattened.get(target) : undefined;
    if (
      entries !== undefined &&
      Object.getPrototypeOf(target) === YAMLMap.prototype
    ) {
      const object: Record<string, unknown> = {};
      values.set(target, object);
      for (const entry of entries) {
        if (!entry.shadowed) {
          Object.defineProperty(object, entry.name, {
            value: valueOf(entry.value),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
      return object;
    }
    if (
      isSeq(target) &&
      Object.getPrototypeOf(target) === YAMLSeq.prototype &&
      !target.items.some(isPair)
    ) {
      const list: unknown[] = [];
      values.set(target, list);
      target.items.forEach((item) => list.push(valueOf(item)));
      return list;
    }
    // A `!!set`, `!!omap` or `!!pairs` collection, or no document.
    const value = isNode(target)
      ? target.toJS(doc, { maxAliasCount: -1 })
      : null;
    values.set(target, value);
    return value;
  };

  return {
    value: valueOf(doc.contents),
    nonStringKeys,
    duplicateKeys: duplicates.map(({ map, key }) => ({
      ...key,
      keeps: constructed.has(map) ? "last" : "first",
    })),
  };
}

/**
 * The YAML document in `source`, read as Metabase reads it (clj-yaml over
 * SnakeYAML: YAML 1.1 types, `<<` merge keys, SnakeYAML's limits). A map key
 * that SnakeYAML reads as something other than a string is in the value
 * under its text, and listed in `nonStringKeys`. A timestamp is a `Date`
 * with no time (`NaN`). A key a map holds again is in `duplicateKeys`, and
 * the value holds the one SnakeYAML keeps (`DuplicateKey.keeps`): Metabase's loader
 * leaves SnakeYAML's `allowDuplicateKeys` at its default, true
 * (`src/metabase/util/yaml.clj` `with-parse-defaults`). Throws
 * `YamlReadError` for any text SnakeYAML refuses, such as a merge source that
 * is not a map, for a document whose aliases expand to more than 3145728
 * nodes, which SnakeYAML reads, and for an alias to a map or list that holds
 * it, which Metabase cannot read.
 */
export function readYaml(source: string): YamlDocument {
  // SnakeYAML skips a leading byte order mark but counts it toward the
  // code-point limit; positions do not count it.
  const bom = source.startsWith("\ufeff") ? 1 : 0;
  const text = source.slice(bom);
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
  if (bom + codePointsBefore(text, scannedEnd(doc, text)) > CODE_POINT_LIMIT) {
    throw new YamlReadError(
      `the document exceeds the limit of ${CODE_POINT_LIMIT} code points`,
      1,
      1,
    );
  }
  return inspect(doc, text, lineCounter);
}
