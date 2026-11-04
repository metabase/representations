import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { resolve } from "path";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples", "v1");

export interface Example {
  file: string;
  document: unknown;
}

export function readExamples(): Example[] {
  return globSync("**/*.yaml", { cwd: EXAMPLES })
    .sort()
    .map((file) => ({
      file,
      document: yaml.load(readFileSync(resolve(EXAMPLES, file), "utf8")),
    }));
}
