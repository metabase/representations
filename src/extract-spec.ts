import { copyFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

export type ExtractSpecOptions = {
  file: string;
};

export type ExtractSpecResult = {
  source: string;
  target: string;
};

export function extractSpec({ file }: ExtractSpecOptions): ExtractSpecResult {
  const source = resolve(PACKAGE_ROOT, "core-spec/v1/spec.md");
  const target = resolve(file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return { source, target };
}
