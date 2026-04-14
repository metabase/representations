#!/usr/bin/env node

import { parseArgs } from "node:util";
import { relative } from "path";

import { extractSchema } from "../src/extract-schema.js";
import { extractSpec } from "../src/extract-spec.js";
import { validateSchema } from "../src/validate-schema.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    folder: { type: "string" },
    file: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];

const HELP = `Usage: representations <command> [options]

Commands:
  validate-schema    Validate YAML files against Metabase representation schemas
    --folder <path>    Folder to validate (default: cwd)

  extract-spec       Copy the bundled spec.md into a target file
    --file <path>      Destination file (default: ./spec.md)

  extract-schema     Copy bundled schemas into a target folder
    --folder <path>    Destination folder (default: cwd)

Options:
  -h, --help           Show this help message`;

if (values.help || !command) {
  console.log(HELP);
  process.exit(command ? 0 : 1);
}

if (command === "validate-schema") {
  const folder = values.folder ?? process.cwd();
  const { results, passed, failed } = validateSchema({ folder });

  if (results.length === 0) {
    console.error(`No YAML files found in ${folder}`);
    process.exit(1);
  }

  for (const result of results) {
    const path = relative(process.cwd(), `${folder}/${result.file}`);
    if (result.status === "ok") {
      console.log(`OK    ${path} (${result.model})`);
    } else {
      console.error(`FAIL  ${path}${result.model ? ` (${result.model})` : ""}`);
      for (const error of result.errors) {
        console.error(`      ${error.path} ${error.message}`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

if (command === "extract-spec") {
  const { target } = extractSpec({ file: values.file ?? "spec.md" });
  console.log(`Spec extracted to ${target}`);
  process.exit(0);
}

if (command === "extract-schema") {
  const { target } = extractSchema({ folder: values.folder ?? process.cwd() });
  console.log(`Schemas extracted to ${target}`);
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
