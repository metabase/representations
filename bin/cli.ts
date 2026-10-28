#!/usr/bin/env node

import { parseArgs } from "node:util";
import { relative } from "path";

import { extractSchema } from "../src/extract-schema.js";
import { extractSpec } from "../src/extract-spec.js";
import { generateEntityId } from "../src/generate-entity-id.js";
import { generateUuid } from "../src/generate-uuid.js";
import { DEFECTS, inject, InjectError } from "../src/inject.js";
import { LINT_RULE_SEVERITY } from "../src/findings.js";
import { lint, type LintResult } from "../src/lint.js";
import { CONFIG_FILE, LintSetupError } from "../src/settings.js";
import { validateSchema } from "../src/validate-schema.js";

type ParsedValues = {
  folder?: string;
  file?: string;
  count?: string;
  "default-schema"?: string[];
  experimental?: boolean;
  defect?: string;
  entity?: string;
  list?: boolean;
  help?: boolean;
};

const HELP = `Usage: representations <command> [options]

Commands:
  validate-schema    Validate YAML files against Metabase representation schemas
    --folder <path>    Folder to validate (default: cwd)

  lint               Experimental: its rules, output and options can change
                     in any release, and it runs only with --experimental.
                     Checks references between transforms, tables and
                     transform tests; prints one JSON finding per line,
                     grouped by rule, then by file. Exits 1 on an error
                     finding or when the folder has no YAML files, and 2
                     when it cannot run
    --experimental     Run the experimental lint (required)
    --folder <path>    Folder to lint (default: cwd)
    --default-schema <database>=<schema>
                       The schema unqualified table names resolve to in
                       a database (repeatable; <database>= for none),
                       over ${CONFIG_FILE} in the folder

  inject             Experimental: its defects, output and options can change
                     in any release, and it runs only with --experimental.
                     Plants one lint defect in a folder, editing its files
                     in place, where the lint then reports that rule alone.
                     Prints the edit and the new findings. Exits 1 when
                     no place in the folder takes the defect
    --experimental     Run the experimental inject (required)
    --folder <path>    Folder to edit (default: cwd)
    --defect <name>    The defect, named by the rule it makes fire
    --entity <id>      Plant it in the document with this entity_id
    --default-schema <database>=<schema>
                       As for lint
    --list             List the defects

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
      experimental: { type: "boolean", default: false },
      defect: { type: "string" },
      entity: { type: "string" },
      list: { type: "boolean", default: false },
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

/** `run`'s result; exits with status 2, printing why, when the lint cannot run. */
async function exitIfLintCannotRun<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof LintSetupError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
}

/**
 * Exits with status 1, saying why, unless `--experimental` was given;
 * `unstable` names what of `command` can change in any release.
 */
function exitUnlessExperimental(
  values: ParsedValues,
  command: string,
  unstable: string,
): void {
  if (!values.experimental) {
    console.error(
      `${command} is experimental: ${unstable} can change in any release. Rerun with --experimental to run it.`,
    );
    process.exit(1);
  }
}

async function handleLint(values: ParsedValues): Promise<void> {
  exitUnlessExperimental(values, "lint", "its rules, output and options");
  const folder = values.folder ?? process.cwd();
  const defaultSchemas = parseDefaultSchemas(values["default-schema"] ?? []);
  const result: LintResult = await exitIfLintCannotRun(() =>
    lint({ folder, defaultSchemas }),
  );
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

function listDefects(): void {
  for (const { name, description } of DEFECTS) {
    console.log(
      `${name.padEnd(30)} ${LINT_RULE_SEVERITY[name].padEnd(7)} ${description}`,
    );
  }
}

async function handleInject(values: ParsedValues): Promise<void> {
  exitUnlessExperimental(values, "inject", "its defects, output and options");
  if (values.list) {
    listDefects();
    process.exit(0);
  }
  if (values.defect === undefined) {
    console.error("inject needs --defect <name>, or --list");
    process.exit(1);
  }
  const folder = values.folder ?? process.cwd();
  const options = {
    folder,
    defect: values.defect,
    entity: values.entity,
    defaultSchemas: parseDefaultSchemas(values["default-schema"] ?? []),
  };
  const injection = await exitIfLintCannotRun(async () => {
    try {
      return await inject(options);
    } catch (e) {
      if (e instanceof InjectError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
  });
  const { entity } = injection;
  console.log(
    `Planted ${injection.defect} in ${injection.file} (${entity.model} ${entity.name ?? ""}, ${entity.entity_id ?? "no entity_id"}):`,
  );
  console.log(`  ${injection.change}`);
  console.log(`Wrote ${injection.files.join(", ")}`);
  console.log("The lint now also reports:");
  for (const finding of injection.findings) {
    console.log(
      `  ${finding.severity} ${finding.rule} ${finding.file}: ${finding.message}`,
    );
  }
  process.exit(0);
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
    case "inject":
      return handleInject(values);
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
