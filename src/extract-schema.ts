import { cpSync, mkdirSync } from "fs";
import { resolve } from "path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

export type ExtractSchemaOptions = {
  folder: string;
};

export type ExtractSchemaResult = {
  source: string;
  target: string;
};

export function extractSchema({
  folder,
}: ExtractSchemaOptions): ExtractSchemaResult {
  const schemasDir = resolve(PACKAGE_ROOT, "core-spec/v1/schemas");
  const target = resolve(folder);
  mkdirSync(target, { recursive: true });
  cpSync(schemasDir, target, { recursive: true });
  return { source: schemasDir, target };
}
