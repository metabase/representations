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

// SnakeYAML's `ConstructYamlTimestamp` parses with this pattern.
const TIMESTAMP_PARTS =
  /^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:(?:[Tt]|[ \t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\.([0-9]*))?(?:[ \t]*(?:Z|([-+][0-9][0-9]?)(?::([0-9][0-9]))?))?)?$/;

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

const DAY_MS = 86_400_000;
/** The fixed date (day 1 is 0001-01-01, Gregorian) of 1970-01-01. */
const EPOCH_FIXED_DATE = 719_163;
/** The fixed date of 1582-10-15, the first Gregorian day of Java's `GregorianCalendar`. */
const GREGORIAN_CUTOVER_FIXED_DATE = 577_736;
const GREGORIAN_CUTOVER_YEAR = 1582;

/** The fixed date of the first day of `month` (1-12) of `year`, proleptic Gregorian. */
function gregorianFixedDate(year: number, month: number): number {
  const date = new Date(0);
  // `setUTCFullYear`, unlike `Date.UTC`, does not read years 0-99 as 1900-1999.
  date.setUTCFullYear(year, month - 1, 1);
  return Math.floor(date.getTime() / DAY_MS) + EPOCH_FIXED_DATE;
}

/** The fixed date of the first day of `month` (1-12) of `year`, Julian, as Java's `JulianCalendar` counts it. */
function julianFixedDate(year: number, month: number): number {
  const leap = ((year % 4) + 4) % 4 === 0;
  return (
    365 * (year - 1) -
    1 +
    Math.floor((year - 1) / 4) +
    Math.floor((367 * month - 362) / 12) -
    (month > 2 ? (leap ? 1 : 2) : 0)
  );
}

/**
 * SnakeYAML's `ConstructYamlTimestamp`, on a text that matches `TIMESTAMP`.
 * A date alone is midnight UTC, a time with no zone is UTC, and a fraction
 * of a second rounds to milliseconds. Fields out of range carry over, and a
 * day before 1582-10-15 is a Julian date, as in Java's lenient
 * `GregorianCalendar`.
 */
function readTimestamp(
  text: string,
  onError: (message: string) => void,
): Date | null {
  const parts = TIMESTAMP_PARTS.exec(text);
  if (parts === null) {
    onError(`${text} is not a timestamp`);
    return null;
  }
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    zoneHour,
    zoneMinute,
  ] = parts.map((part) => part ?? "0");
  const zoneSign = zoneHour.startsWith("-") ? -1 : 1;
  const zoneMs =
    (Number(zoneHour) * 60 + zoneSign * Number(zoneMinute)) * 60_000;
  // SnakeYAML rounds the seconds' fraction to milliseconds, in doubles.
  const seconds = Number(`${second}.${fraction}`);
  const wholeSeconds = Math.floor(seconds);
  const localMs =
    ((Number(hour) * 60 + Number(minute)) * 60 + wholeSeconds) * 1000 +
    Math.round((seconds - wholeSeconds) * 1000);
  // GregorianCalendar carries a month past December into the year, and the
  // time of day past midnight into the date, before it picks the calendar.
  const monthIndex = Number(month) - 1;
  const fullYear = Number(year) + Math.floor(monthIndex / 12);
  const fullMonth = (((monthIndex % 12) + 12) % 12) + 1;
  const dayOffset = Number(day) - 1 + Math.floor(localMs / DAY_MS);
  const gregorian = gregorianFixedDate(fullYear, fullMonth) + dayOffset;
  const fixedDate =
    Number(year) >= GREGORIAN_CUTOVER_YEAR &&
    gregorian >= GREGORIAN_CUTOVER_FIXED_DATE
      ? gregorian
      : julianFixedDate(fullYear, fullMonth) + dayOffset;
  return new Date(
    (fixedDate - EPOCH_FIXED_DATE) * DAY_MS + (localMs % DAY_MS) - zoneMs,
  );
}

/** SnakeYAML's implicit scalar types, each with its constructor. */
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
    resolve: readTimestamp,
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
