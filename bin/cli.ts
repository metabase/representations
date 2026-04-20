#!/usr/bin/env node

import { parseArgs } from "node:util";
import { relative } from "path";

import { extractSchema } from "../src/extract-schema.js";
import { extractSpec } from "../src/extract-spec.js";
import { generateEntityId } from "../src/generate-entity-id.js";
import { generateUuid } from "../src/generate-uuid.js";
import { validateSchema } from "../src/validate-schema.js";

type ParsedValues = {
  folder?: string;
  file?: string;
  count?: string;
  help?: boolean;
};

const HELP = `Usage: representations <command> [options]

Commands:
  validate-schema    Validate YAML files against Metabase representation schemas
    --folder <path>    Folder to validate (default: cwd)

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

function handleValidateSchema(values: ParsedValues): void {
  const folder = values.folder ?? process.cwd();
  const { results, passed, failed } = validateSchema({ folder });

  if (results.length === 0) {
    console.error(`No YAML files found in ${folder}`);
    process.exit(1);
  }

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

function handleGenerateEntityId(values: ParsedValues): void {
  const count = parseCount(values.count);
  for (let i = 0; i < count; i++) {
    console.log(generateEntityId());
  }
  process.exit(0);
}

function handleGenerateUuid(values: ParsedValues): void {
  const count = parseCount(values.count);
  for (let i = 0; i < count; i++) {
    console.log(generateUuid());
  }
  process.exit(0);
}

function main(): void {
  const { values, positionals } = parseArguments();
  const command = positionals[0];

  if (values.help || !command) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  switch (command) {
    case "validate-schema":
      return handleValidateSchema(values);
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

main();
