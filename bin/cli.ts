#!/usr/bin/env node

import { parseArgs } from "node:util";
import { relative } from "path";

import { extractSchema } from "../src/extract-schema.js";
import { extractSpec } from "../src/extract-spec.js";
import { generateEntityId } from "../src/generate-entity-id.js";
import { generateUuid } from "../src/generate-uuid.js";
import { lint, type LintResult } from "../src/lint.js";
import { CONFIG_FILE, LintSetupError } from "../src/settings.js";
import { validateSchema } from "../src/validate-schema.js";

type ParsedValues = {
  folder?: string;
  file?: string;
  count?: string;
  "default-schema"?: string[];
  help?: boolean;
};

const HELP = `Usage: representations <command> [options]

Commands:
  validate-schema    Validate YAML files against Metabase representation schemas
    --folder <path>    Folder to validate (default: cwd)

  lint               Check references between transforms, tables and transform
                     tests; prints one JSON finding per line, grouped
                     by rule, then by file. Exits 1 on an error finding,
                     and 2 when it cannot run
    --folder <path>    Folder to lint (default: cwd)
    --default-schema <database>=<schema>
                       The schema unqualified table names resolve to in
                       a database (repeatable; <database>= for none),
                       over ${CONFIG_FILE} in the folder

  extract-spec       Copy the bundled spec.md into a target file
    --file <path>      Destination file (default: ./spec.md)

  extract-schema     Copy bundled schemas into a target folder
    --folder <path>    Destination folder (default: cwd)

  generate-entity-id Generate one or more NanoID entity IDs (one per line)
    --count <n>        Number to generate (default: 1)

  generate-uuid      Generate one or more UUIDs (one per line)
    --count <n>        Number to generate (default: 1)

Options:
  -h, --help           Show this help message`;

function parseArguments() {
  return parseArgs({
    allowPositionals: true,
    options: {
      folder: { type: "string" },
      "default-schema": { type: "string", multiple: true },
      file: { type: "string" },
      count: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function parseCount(raw: string | undefined): number {
  const count = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    console.error(`Invalid --count: ${raw} (expected a positive integer)`);
    process.exit(1);
  }
  return count;
}

/** Exits with status 1, saying so, when a command found no files in `folder`. */
function exitIfNoFiles(files: number, folder: string): void {
  if (files === 0) {
    console.error(`No YAML files found in ${folder}`);
    process.exit(1);
  }
}

function handleValidateSchema(values: ParsedValues): void {
  const folder = values.folder ?? process.cwd();
  const { results, passed, failed } = validateSchema({ folder });

  exitIfNoFiles(results.length, folder);

  for (const result of results) {
    if (result.status === "ok") {
      continue;
    }
    const path = relative(process.cwd(), `${folder}/${result.file}`);
    console.error(`FAIL  ${path}${result.model ? ` (${result.model})` : ""}`);
    for (const error of result.errors) {
      console.error(`      ${error.path} ${error.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
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
      console.error(
        `Invalid --default-schema: ${pair} (expected DATABASE=SCHEMA)`,
      );
      process.exit(1);
    }
    const schema = pair.slice(at + 1);
    schemas[pair.slice(0, at)] = schema === "" ? null : schema;
  }
  return schemas;
}

async function handleLint(values: ParsedValues): Promise<void> {
  const folder = values.folder ?? process.cwd();
  const defaultSchemas = parseDefaultSchemas(values["default-schema"] ?? []);
  let result: LintResult;
  try {
    result = await lint({ folder, defaultSchemas });
  } catch (e) {
    if (e instanceof LintSetupError) {
      console.error(e.message);
      process.exit(2);
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
  const command = positionals[0];

  if (values.help || !command) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
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
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

await main();
