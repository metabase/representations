#!/usr/bin/env node

import { parseArgs } from "node:util";
import { relative } from "path";
import { validateSchema } from "../src/validate-schema.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    folder: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];

if (values.help || !command) {
  console.log(`Usage: representations <command> [options]

Commands:
  validate-schema    Validate YAML files against Metabase representation schemas

Options:
  --folder <path>      Folder to validate (default: current directory)
  -h, --help           Show this help message`);
  process.exit(command ? 0 : 1);
}

if (command !== "validate-schema") {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

const folder = values.folder ?? process.cwd();
const { results, passed, failed } = validateSchema({ folder });

if (results.length === 0) {
  console.error(`No YAML files found in ${folder}`);
  process.exit(1);
}

for (const r of results) {
  const relPath = relative(process.cwd(), `${folder}/${r.file}`);
  if (r.status === "ok") {
    console.log(`OK    ${relPath} (${r.model})`);
  } else {
    console.error(`FAIL  ${relPath}${r.model ? ` (${r.model})` : ""}`);
    for (const error of r.errors) {
      console.error(`      ${error.path} ${error.message}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
