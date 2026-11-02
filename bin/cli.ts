#!/usr/bin/env node

import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { relative } from "path";

import type { DefaultSchemas } from "../src/default-schemas.js";
import { extractSchema } from "../src/extract-schema.js";
import { extractSpec } from "../src/extract-spec.js";
import { generateEntityId } from "../src/generate-entity-id.js";
import { generateUuid } from "../src/generate-uuid.js";
import { lint, type LintResult } from "../src/lint.js";
import {
  CONFIG_FILE,
  LintSetupError,
  parseDefaultSchemas,
  readSettingsFile,
} from "../src/settings.js";
import { validateSchema } from "../src/validate-schema.js";
import {
  describeThrown,
  errorMessage,
  escapeUnprintable,
} from "../src/values.js";

type ParsedValues = {
  folder?: string;
  file?: string;
  count?: string;
  "default-schema"?: string[];
  experimental?: boolean;
  help?: boolean;
};

const DOCS_URL =
  "https://github.com/metabase/representations/blob/main/README.md#lint";

const HELP = `Usage: representations <command> [options]

Commands:
  validate-schema    Validate YAML files against Metabase representation schemas
    --folder <path>    Folder to validate (default: cwd)

  lint               Experimental: its rules, output and options can change
                     in any release, and it runs only with --experimental.
                     Checks the transforms and transform tests in a
                     folder, and the references between them, for what
                     Metabase refuses or likely gets wrong; prints one
                     JSON finding per line, grouped by rule, then by
                     file. Rules and finding
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
     --experimental), a folder that is missing, is not a folder or has
     no YAML files in Metabase's top-level folders, a lint that cannot
     run (an invalid settings file, a SQL parser that cannot start), or
     an unexpected error, such as a file or folder lint cannot read.`;

/** The exit code when nothing was checked: a usage error, no files, a lint that cannot run, or an unexpected error. */
const NOTHING_CHECKED = 2;

/**
 * Prints `text`, whose line feeds are its own, on stderr with each line
 * escaped by `escapeUnprintable`. Text from the folder in it must be quoted
 * with `JSON.stringify`, which escapes a line feed.
 */
function printError(text: string): void {
  console.error(text.split("\n").map(escapeUnprintable).join("\n"));
}

/** The end of a command, with its exit code. */
class CommandExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Ends the command with exit code `code`. The process exits once its output
 * is written: `exit()` drops output still queued for a pipe.
 */
function exit(code: number): never {
  throw new CommandExit(code);
}

/** Exits with code 2 after `message` and a pointer to the help. */
function usageError(message: string): never {
  console.error(`${message}\nSee representations --help.`);
  exit(NOTHING_CHECKED);
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
    exit(NOTHING_CHECKED);
  }
  if (!stat.isDirectory()) {
    console.error(
      `Not a folder: ${folder}. Pass the folder that holds the YAML files.`,
    );
    exit(NOTHING_CHECKED);
  }
  return folder;
}

/** Exits with code 2, saying so, when a command found no files in `folder`. */
function exitIfNoFiles(files: number, folder: string): void {
  if (files === 0) {
    console.error(
      `No YAML files found in ${folder}: Metabase imports only the .yaml files under collections/, databases/, transforms/ and its other top-level folders`,
    );
    exit(NOTHING_CHECKED);
  }
}

function handleValidateSchema(values: ParsedValues): void {
  const folder = folderToCheck(values);
  const { results, passed, failed, skipped, unchecked } = validateSchema({
    folder,
  });

  exitIfNoFiles(results.length, folder);

  // File names, keys and model names are the folder's text.
  const printLine = (line: string) => console.error(escapeUnprintable(line));
  for (const result of results) {
    const path = relative(process.cwd(), `${folder}/${result.file}`);
    switch (result.status) {
      case "ok":
      case "unchecked":
        break;
      case "skipped":
        printLine(`WARN  ${path}`);
        printLine(`      ${result.warning}`);
        break;
      case "fail":
        printLine(`FAIL  ${path}${result.model ? ` (${result.model})` : ""}`);
        for (const error of result.errors) {
          printLine(`      ${error.path} ${error.message}`);
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
  exit(failed > 0 ? 1 : 0);
}

/**
 * Says on stderr which default schema each `--default-schema` sets, and
 * which it overrides in the settings file; warns on a database the folder's
 * files do not name (`named`), such as a misspelled one.
 */
function echoDefaultSchemas(
  folder: string,
  given: Readonly<Record<string, string | null>>,
  named: readonly string[],
): void {
  const settings = readSettingsFile(folder).defaultSchemas;
  const show = (schema: string | null) =>
    schema === null ? "none (no schemas)" : JSON.stringify(schema);
  for (const database of Object.keys(given)) {
    const over = Object.hasOwn(settings, database)
      ? `, over ${show(settings[database])} in ${CONFIG_FILE}`
      : "";
    printError(
      `--default-schema: ${database} has the default schema ${show(given[database])}${over}`,
    );
    if (!named.includes(database)) {
      printError(
        `Warning: --default-schema names ${database}, which no file in the folder names`,
      );
    }
  }
}

async function handleLint(values: ParsedValues): Promise<void> {
  if (!values.experimental) {
    usageError(
      "lint is experimental: its rules, output and options can change in any release. Rerun with --experimental to run it.",
    );
  }
  const folder = folderToCheck(values);
  let defaultSchemas: DefaultSchemas;
  try {
    defaultSchemas = parseDefaultSchemas(values["default-schema"] ?? []);
  } catch (e) {
    usageError(errorMessage(e));
  }
  let result: LintResult;
  try {
    result = await lint({ folder, defaultSchemas });
  } catch (e) {
    if (e instanceof LintSetupError) {
      printError(e.message);
      exit(NOTHING_CHECKED);
    }
    throw e;
  }
  const { files, findings, databases } = result;

  exitIfNoFiles(files, folder);
  echoDefaultSchemas(folder, defaultSchemas, databases);

  for (const finding of findings) {
    console.log(escapeUnprintable(JSON.stringify(finding)));
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  console.error(`${files} files, ${errors} errors, ${warnings} warnings`);
  exit(errors > 0 ? 1 : 0);
}

function handleExtractSpec(values: ParsedValues): void {
  const { target } = extractSpec({ file: values.file ?? "spec.md" });
  console.log(`Spec extracted to ${target}`);
  exit(0);
}

function handleExtractSchema(values: ParsedValues): void {
  const { target } = extractSchema({ folder: values.folder ?? process.cwd() });
  console.log(`Schemas extracted to ${target}`);
  exit(0);
}

/** Prints `--count` values of `generate`, one per line, then exits. */
function handleGenerate(values: ParsedValues, generate: () => string): void {
  const count = parseCount(values.count);
  for (let i = 0; i < count; i++) {
    console.log(generate());
  }
  exit(0);
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
    exit(0);
  }
  if (command === undefined) {
    console.log(HELP);
    exit(NOTHING_CHECKED);
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

try {
  await main();
} catch (e) {
  if (e instanceof CommandExit) {
    process.exitCode = e.code;
  } else {
    // Any other error stops the command before it checked everything.
    console.error(describeThrown(e));
    process.exitCode = NOTHING_CHECKED;
  }
}
