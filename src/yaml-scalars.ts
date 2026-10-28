import type { ScalarTag, Tags } from "yaml";

// The implicit resolvers of SnakeYAML's `Resolver`: YAML 1.1 as SnakeYAML
// reads it, which differs from the 1.1 spec (no `y`/`n` booleans, an octal
// must be valid, a float may omit the dot before an exponent).
const BOOL =
  /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const INT =
  /^(?:[-+]?0b_*[0-1][0-1_]*|[-+]?0_*[0-7][0-7_]*|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x_*[0-9a-fA-F][0-9a-fA-F_]*|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const FLOAT =
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+]?[0-9]+)?|[-+]?(?:[0-9][0-9_]*)(?:[eE][-+]?[0-9]+)|[-+]?\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const NULL = /^(?:~|null|Null|NULL|)$/;
const TIMESTAMP =
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;

/** `text` without its sign, and the sign as 1 or -1. */
function splitSign(text: string): [number, string] {
  return text.startsWith("-")
    ? [-1, text.slice(1)]
    : [1, text.startsWith("+") ? text.slice(1) : text];
}

/** The value of `a:b:c` in base 60. */
function sexagesimal(text: string): number {
  return text
    .split(":")
    .reduce((value, digit) => value * 60 + Number(digit), 0);
}

/** SnakeYAML's `ConstructYamlInt`, on a text that matches `INT`. */
function readInt(text: string): number {
  const [sign, digits] = splitSign(text.replaceAll("_", ""));
  if (digits === "0") {
    return 0;
  }
  const value = digits.startsWith("0b")
    ? parseInt(digits.slice(2), 2)
    : digits.startsWith("0x")
      ? parseInt(digits.slice(2), 16)
      : digits.startsWith("0")
        ? parseInt(digits.slice(1), 8)
        : digits.includes(":")
          ? sexagesimal(digits)
          : parseInt(digits, 10);
  // SnakeYAML's integers have no negative zero.
  return value === 0 ? 0 : sign * value;
}

/**
 * SnakeYAML's `ConstructYamlFloat`, on a text that matches `FLOAT`. An error
 * for `FLOAT` matches with no digits, such as `._`, which SnakeYAML refuses.
 */
function readFloat(
  text: string,
  onError: (message: string) => void,
): number | null {
  const [sign, digits] = splitSign(text.replaceAll("_", ""));
  const lower = digits.toLowerCase();
  const value =
    lower === ".inf"
      ? Infinity
      : lower === ".nan"
        ? NaN
        : digits.includes(":")
          ? sexagesimal(digits)
          : Number(digits);
  if (Number.isNaN(value) && lower !== ".nan") {
    onError(`${text} is not a float`);
    return null;
  }
  return sign * value;
}

/** SnakeYAML's implicit scalar types, each with its value. */
const SNAKE_SCALAR_TAGS = [
  {
    tag: "tag:yaml.org,2002:null",
    default: true,
    test: NULL,
    resolve: () => null,
  },
  {
    tag: "tag:yaml.org,2002:bool",
    default: true,
    test: BOOL,
    resolve: (text) => /^(?:yes|true|on)$/i.test(text),
  },
  { tag: "tag:yaml.org,2002:int", default: true, test: INT, resolve: readInt },
  {
    tag: "tag:yaml.org,2002:float",
    default: true,
    test: FLOAT,
    resolve: readFloat,
  },
  {
    tag: "tag:yaml.org,2002:timestamp",
    default: true,
    test: TIMESTAMP,
    // SnakeYAML reads a Date. Only its type matters, so its time is not set.
    resolve: () => new Date(Number.NaN),
  },
] as const satisfies readonly ScalarTag[];

const SNAKE_SCALAR_TAG_NAMES = new Set<string>(
  SNAKE_SCALAR_TAGS.map((t) => t.tag),
);

/** The `yaml-1.1` schema's tags, with SnakeYAML's scalar types in place of its own. */
export function snakeTags(tags: Tags): Tags {
  return [
    ...tags.filter(
      (t) => typeof t === "string" || !SNAKE_SCALAR_TAG_NAMES.has(t.tag),
    ),
    ...SNAKE_SCALAR_TAGS,
  ];
}
