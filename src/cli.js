#!/usr/bin/env node

import { parseArgs } from "node:util";
import { lint } from "./lint.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: "string", default: "v1" },
    folder: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];

if (values.help || !command) {
  console.log(`Usage: representations <command> [options]

Commands:
  lint    Validate YAML files against Metabase representation schemas

Options:
  --version <version>  Schema version to validate against (default: v1)
  --folder <path>      Folder to validate (default: current directory)
  -h, --help           Show this help message`);
  process.exit(command ? 0 : 1);
}

if (command !== "lint") {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

const folder = values.folder ?? process.cwd();
const failed = lint({ version: values.version, folder });
process.exit(failed > 0 ? 1 : 0);
