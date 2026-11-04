import { describe, expect, it } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { readFileSync } from "fs";
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
  // `$schema` is dropped as the validator drops it.
  const { $schema: _schema, ...body } = JSON.parse(
    readFileSync(resolve(SCHEMAS, file), "utf8"),
  );
  return body;
};

// Set up as `validateSchema` sets up Ajv.
const ajv = new Ajv2020({
  allErrors: true,
  strictTuples: false,
  allowUnionTypes: true,
});
addFormats(ajv);
const validateManifest = ajv.compile(loadSchema("DataApp.json"));

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

  it.each([
    ["a slug with a capital letter", { ...MANIFEST, slug: "Order-desk" }],
    ["a slug with an underscore", { ...MANIFEST, slug: "order_desk" }],
    ["a slug with two dashes in a row", { ...MANIFEST, slug: "order--desk" }],
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
