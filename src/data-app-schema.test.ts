import { describe, expect, it } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { createRequire } from "node:module";
import { resolve } from "path";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");

const SCHEMAS = resolve(
  import.meta.dirname,
  "..",
  "core-spec",
  "v1",
  "schemas",
);

const loadSchema = (file: string) => {
  // Schema files are YAML maps; `$schema` is dropped as the validator drops it.
  const { $schema: _schema, ...body } = yaml.load(
    readFileSync(resolve(SCHEMAS, file), "utf8"),
  ) as Record<string, unknown>;
  return body;
};

// Set up as `validateSchema` sets up Ajv, so the manifest schema resolves the
// shared definitions the same way.
const ajv = new Ajv2020({
  allErrors: true,
  strictTuples: false,
  allowUnionTypes: true,
});
addFormats(ajv);
for (const file of globSync("common/*.yaml", { cwd: SCHEMAS })) {
  ajv.addSchema(loadSchema(file), file);
}
const validateManifest = ajv.compile(loadSchema("data_app.yaml"));

// The example manifest in the spec's Data App section.
const MANIFEST = {
  name: "Order Desk",
  slug: "order-desk",
  description: "Review orders and apply discounts",
  version: 1,
  path: "./dist/index.js",
  collection: "dApPcOlLeCtIoN0ExAmP1",
  entity_id: "dApPmAnIfEsT000ExAmP1",
  allowed_hosts: ["https://api.example.com"],
  "serdes/meta": [
    { model: "DataApp", id: "dApPmAnIfEsT000ExAmP1", label: "order-desk" },
  ],
};

describe("data app manifest schema", () => {
  it.each([
    ["the spec's example", MANIFEST],
    [
      "only the required fields",
      {
        name: "Order Desk",
        slug: "order-desk",
        entity_id: "dApPmAnIfEsT000ExAmP1",
        path: "dist/index.js",
        collection: "dApPcOlLeCtIoN0ExAmP1",
        "serdes/meta": [{ model: "DataApp", id: "dApPmAnIfEsT000ExAmP1" }],
      },
    ],
    [
      "a wildcard host with a port",
      { ...MANIFEST, allowed_hosts: ["https://*.internal.example.com:8443"] },
    ],
  ])("accepts %s", (_, manifest) => {
    expect(
      validateManifest(manifest),
      JSON.stringify(validateManifest.errors),
    ).toBe(true);
  });

  const without = (key: keyof typeof MANIFEST) => {
    const { [key]: _removed, ...manifest } = MANIFEST;
    return manifest;
  };

  it.each([
    ["no name", without("name")],
    ["a blank name", { ...MANIFEST, name: "   " }],
    ["no slug", without("slug")],
    ["a slug with a capital letter", { ...MANIFEST, slug: "Order-desk" }],
    ["a slug with an underscore", { ...MANIFEST, slug: "order_desk" }],
    ["a slug with two dashes in a row", { ...MANIFEST, slug: "order--desk" }],
    ["a slug of Metabase's own route", { ...MANIFEST, slug: "repo-status" }],
    ["no entity_id", without("entity_id")],
    ["an entity_id that isn't a NanoID", { ...MANIFEST, entity_id: "order" }],
    ["no serdes/meta", without("serdes/meta")],
    [
      "serdes/meta of another model",
      {
        ...MANIFEST,
        "serdes/meta": [{ model: "Collection", id: "dApPmAnIfEsT000ExAmP1" }],
      },
    ],
    ["no path", without("path")],
    [
      "a path leaving the app's directory",
      { ...MANIFEST, path: "../other/index.js" },
    ],
    [
      "a path leaving the app's directory after leading spaces",
      { ...MANIFEST, path: "  ../other/index.js" },
    ],
    ["no collection", without("collection")],
    [
      "a collection that isn't an entity ID",
      { ...MANIFEST, collection: "Order Desk" },
    ],
    ["a version of 0", { ...MANIFEST, version: 0 }],
    ["a version that isn't a whole number", { ...MANIFEST, version: 1.5 }],
    [
      "a description over 255 characters",
      { ...MANIFEST, description: "x".repeat(256) },
    ],
    [
      "a description that isn't a string",
      { ...MANIFEST, description: ["a", "b"] },
    ],
    [
      "allowed hosts that aren't a list",
      { ...MANIFEST, allowed_hosts: "https://api.example.com" },
    ],
    [
      "an allowed host with a path",
      { ...MANIFEST, allowed_hosts: ["https://api.example.com/v1"] },
    ],
    [
      "an allowed host without a scheme",
      { ...MANIFEST, allowed_hosts: ["api.example.com"] },
    ],
    [
      "an allowed host that is only a wildcard",
      { ...MANIFEST, allowed_hosts: ["*"] },
    ],
  ])("rejects %s", (_, manifest) => {
    expect(validateManifest(manifest)).toBe(false);
  });
});
