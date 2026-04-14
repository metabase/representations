import { cpSync, mkdirSync } from "fs";
import { resolve } from "path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

export function extractSchema({ folder }) {
  const schemasDir = resolve(PACKAGE_ROOT, "core-spec/v1/schemas");
  const target = resolve(folder);
  mkdirSync(target, { recursive: true });
  cpSync(schemasDir, target, { recursive: true });
  return { source: schemasDir, target };
}
