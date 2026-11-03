import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { resolve } from "path";

import {
  getPortableKind,
  REF_MODELS,
  type InstanceToPortable,
  type Kind,
  type PortableToInstance,
} from "../index.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");

export interface Example {
  file: string;
  kind: Kind;
  document: unknown;
}

export function readExamples(): Example[] {
  return globSync("v1/**/*.yaml", { cwd: EXAMPLES })
    .sort()
    .flatMap((file) => {
      const document: unknown = yaml.load(
        readFileSync(resolve(EXAMPLES, file), "utf8"),
      );
      const kind = getPortableKind(document);
      return kind === null ? [] : [{ file, kind, document }];
    });
}

export function readInstanceIds(): PortableToInstance {
  return JSON.parse(
    readFileSync(resolve(EXAMPLES, "instance-ids.json"), "utf8"),
  );
}

export function toPortableRefsMap(ids: PortableToInstance): InstanceToPortable {
  return Object.fromEntries(
    REF_MODELS.map((model) => [
      model,
      Object.fromEntries(
        Object.entries(ids[model] ?? {}).map(([key, id]) => [
          id,
          model === "Table" || model === "Field" ? JSON.parse(key) : key,
        ]),
      ),
    ]),
  );
}
