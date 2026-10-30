#!/usr/bin/env node

import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { relative } from "path";

import { MissingDefaultSchemasError } from "../src/default-schemas.js";
import { extractSchema } from "../src/extract-schema.js";
import { extractSpec } from "../src/extract-spec.js";
import { generateEntityId } from "../src/generate-entity-id.js";
import { generateUuid } from "../src/generate-uuid.js";
import { lint, type LintResult } from "../src/lint.js";
import { CONFIG_FILE, LintSetupError } from "../src/settings.js";
import { validateSchema } from "../src/validate-schema.js";
import { errorMessage } from "../src/values.js";

type ParsedValues = {
  folder?: string;
  file?: string;
  count?: string;
  "default-schema"?: string[];
  experimental?: boolean;
  help?: boolean;
};

const DOCS_URL =
  "https://github.com/metabase/representations/blob/main/README.md#lint-rules";

const HELP = `Usage: representations <command> [options]

Commands:
  validate-schema    Validate YAML files against Metabase representation schemas
    --folder <path>    Folder to validate (default: cwd)

  lint               Experimental: its rules, output and options can change
                     in any release, and it runs only with --experimental.
                     Checks references between transforms, tables and
                     transform tests; prints one JSON finding per line,
                     grouped by rule, then by file. Rules and finding
                     fields: ${DOCS_URL}
    --experimental     Run the experimental lint (required)
    --folder <path>    Folder to lint (default: cwd)
    --default-schema <database>=<schema>
                       The schema unqualified table names resolve to in
                       a database (repeatable; <database>= for none).
                       Overrides defaultSchemas in ${CONFIG_FILE}

  extract-spec       Copy the bundled spec.md into a target file
    --file <path>      Destination file (default: ./spec.md)

  extract-schema     Copy bundled schemas into a target folder
    --folder <path>    Destination folder (default: cwd)

  generate-entity-id Generate one or more NanoID entity IDs (one per line)
    --count <n>        Number to generate (default: 1)

  generate-uuid      Generate one or more UUIDs (one per line)
    --count <n>        Number to generate (default: 1)

Options:
  -h, --help           Show this help message

Exit codes:
  0  The command ran. validate-schema: no file failed; lint: no finding
     is an error.
  1  validate-schema: a file failed; lint: a finding is an error.
  2  Nothing was checked: a usage error (an unknown command or option, an
     option with no value or an invalid one, lint without
     --experimental), a folder that is missing, is not a folder or holds
     no YAML files, or a lint that cannot run (an invalid settings file,
     an unknown default schema, a SQL parser that cannot start).`;

/** The exit code when nothing was checked: a usage error, no files, or a lint that cannot run. */
const NOTHING_CHECKED = 2;

/** Exits with code 2 after `message` and a pointer to the help. */
function usageError(message: string): never {
  console.error(`${message}\nSee representations --help.`);
  process.exit(NOTHING_CHECKED);
}

/** The command line's options and positionals; a usage error when it does not parse. */
function parseArguments() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        folder: { type: "string" },
        "default-schema": { type: "string", multiple: true },
        experimental: { type: "boolean", default: false },
        file: { type: "string" },
        count: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    return usageError(errorMessage(e));
  }
}

function parseCount(raw: string | undefined): number {
  const count = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    usageError(`Invalid --count: ${raw} (expected a positive integer)`);
  }
  return count;
}

/**
 * The folder `--folder` names, or the current directory; exits with code 2,
 * saying why, when it is missing or is not a folder.
 */
function folderToCheck(values: ParsedValues): string {
  const folder = values.folder ?? process.cwd();
  const stat = statSync(folder, { throwIfNoEntry: false });
  if (stat === undefined) {
    console.error(`No such folder: ${folder}`);
    process.exit(NOTHING_CHECKED);
  }
  if (!stat.isDirectory()) {
    console.error(
      `Not a folder: ${folder}. Pass the folder that holds the YAML files.`,
    );
    process.exit(NOTHING_CHECKED);
  }
  return folder;
}

/** Exits with code 2, saying so, when a command found no files in `folder`. */
function exitIfNoFiles(files: number, folder: string): void {
  if (files === 0) {
    console.error(`No YAML files found in ${folder}`);
    process.exit(NOTHING_CHECKED);
  }
}

function handleValidateSchema(values: ParsedValues): void {
  const folder = folderToCheck(values);
  const { results, passed, failed, skipped, unchecked } = validateSchema({
    folder,
  });

  exitIfNoFiles(results.length, folder);

  for (const result of results) {
    const path = relative(process.cwd(), `${folder}/${result.file}`);
    switch (result.status) {
      case "ok":
      case "unchecked":
        break;
      case "skipped":
        console.error(`WARN  ${path}`);
        console.error(`      ${result.warning}`);
        break;
      case "fail":
        console.error(
          `FAIL  ${path}${result.model ? ` (${result.model})` : ""}`,
        );
        for (const error of result.errors) {
          console.error(`      ${error.path} ${error.message}`);
        }
        break;
    }
  }

  const counts = [
    `${passed} passed`,
    `${failed} failed`,
    ...(skipped > 0 ? [`${skipped} skipped`] : []),
    ...(unchecked > 0 ? [`${unchecked} not checked`] : []),
  ];
  console.log(`\n${counts.join(", ")}`);
  process.exit(failed > 0 ? 1 : 0);
}

// "DATABASE=SCHEMA" pairs; "DATABASE=" means the database has no schemas.
function parseDefaultSchemas(
  pairs: readonly string[],
): Record<string, string | null> {
  const schemas: Record<string, string | null> = {};
  for (const pair of pairs) {
    const at = pair.lastIndexOf("=");
    if (at <= 0) {
      usageError(
        `Invalid --default-schema: ${pair} (expected DATABASE=SCHEMA)`,
      );
    }
    const schema = pair.slice(at + 1);
    schemas[pair.slice(0, at)] = schema === "" ? null : schema;
  }
  return schemas;
}

async function handleLint(values: ParsedValues): Promise<void> {
  if (!values.experimental) {
    usageError(
      "lint is experimental: its rules, output and options can change in any release. Rerun with --experimental to run it.",
    );
  }
  const folder = folderToCheck(values);
  const defaultSchemas = parseDefaultSchemas(values["default-schema"] ?? []);
  let result: LintResult;
  try {
    result = await lint({ folder, defaultSchemas });
  } catch (e) {
    if (e instanceof MissingDefaultSchemasError) {
      console.error(
        `${e.message}\nOr pass --default-schema "<database>=<schema>" for each, "<database>=" for no schemas.`,
      );
      process.exit(NOTHING_CHECKED);
    }
    if (e instanceof LintSetupError) {
      console.error(e.message);
      process.exit(NOTHING_CHECKED);
    }
    throw e;
  }
  const { files, findings } = result;

  exitIfNoFiles(files, folder);

  for (const finding of findings) {
    console.log(JSON.stringify(finding));
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  console.error(`${files} files, ${errors} errors, ${warnings} warnings`);
  process.exit(errors > 0 ? 1 : 0);
}

function handleExtractSpec(values: ParsedValues): void {
  const { target } = extractSpec({ file: values.file ?? "spec.md" });
  console.log(`Spec extracted to ${target}`);
  process.exit(0);
}

function handleExtractSchema(values: ParsedValues): void {
  const { target } = extractSchema({ folder: values.folder ?? process.cwd() });
  console.log(`Schemas extracted to ${target}`);
  process.exit(0);
}

/** Prints `--count` values of `generate`, one per line, then exits. */
function handleGenerate(values: ParsedValues, generate: () => string): void {
  const count = parseCount(values.count);
  for (let i = 0; i < count; i++) {
    console.log(generate());
  }
  process.exit(0);
}

function handleGenerateEntityId(values: ParsedValues): void {
  handleGenerate(values, generateEntityId);
}

function handleGenerateUuid(values: ParsedValues): void {
  handleGenerate(values, generateUuid);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArguments();
  const [command, ...extra] = positionals;

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (command === undefined) {
    console.log(HELP);
    process.exit(NOTHING_CHECKED);
  }
  if (extra.length > 0) {
    usageError(`Unexpected argument: ${extra[0]}`);
  }

  switch (command) {
    case "validate-schema":
      return handleValidateSchema(values);
    case "lint":
      return handleLint(values);
    case "extract-spec":
      return handleExtractSpec(values);
    case "extract-schema":
      return handleExtractSchema(values);
    case "generate-entity-id":
      return handleGenerateEntityId(values);
    case "generate-uuid":
      return handleGenerateUuid(values);
    default:
      usageError(`Unknown command: ${command}`);
  }
}

await main();
