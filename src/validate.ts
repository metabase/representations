import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { createRequire } from "node:module";

import type { JsonObject } from "./json.js";
import { KIND_SCHEMAS, type Kind } from "./kinds.js";
import { instanceSchemas, portableSchemas } from "./schemas/index.js";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");

declare const portable: unique symbol;
declare const instance: unique symbol;

/** A validated entity of `kind` with portable references: names, paths and entity ids. */
export type PortableEntity<K extends Kind = Kind> = JsonObject & {
  readonly [portable]: K;
};

/** A validated entity of `kind` with instance references: numeric ids of one Metabase. */
export type InstanceEntity<K extends Kind = Kind> = JsonObject & {
  readonly [instance]: K;
};

/** A schema violation; `path` is a JSON Pointer into the validated value. */
export type Issue = {
  path: string;
  message: string;
};

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; issues: Issue[] };

/** Validates `value` as a portable entity of `kind`. */
export function validatePortable<K extends Kind>(
  kind: K,
  value: unknown,
): Validation<PortableEntity<K>> {
  return validate(portableAjv, kind, value);
}

/** Validates `value` as an instance entity of `kind`. */
export function validateInstance<K extends Kind>(
  kind: K,
  value: unknown,
): Validation<InstanceEntity<K>> {
  return validate(instanceAjv, kind, value);
}

function validate<T>(ajv: Ajv2020, kind: Kind, value: unknown): Validation<T> {
  const validateFunction = ajv.getSchema(KIND_SCHEMAS[kind]);
  if (validateFunction === undefined) {
    throw new Error(`No schema for kind "${kind}"`);
  }
  if (validateFunction(value)) {
    return { ok: true, value: value as T };
  }
  const issues = (validateFunction.errors ?? []).map((error) => ({
    path: error.instancePath,
    message: error.message ?? error.keyword,
  }));
  return { ok: false, issues };
}

function createAjv(schemas: Readonly<Record<string, JsonObject>>): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strictTuples: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  for (const [name, schema] of Object.entries(schemas)) {
    ajv.addSchema(schema, name);
  }
  return ajv;
}

const portableAjv = createAjv(portableSchemas);
const instanceAjv = createAjv(instanceSchemas);
