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
  const { $schema: _schema, ...body } = yaml.load(
    readFileSync(resolve(SCHEMAS, file), "utf8"),
  ) as Record<string, unknown>;
  return body;
};

const ajv = new Ajv2020({
  allErrors: true,
  strictTuples: false,
  allowUnionTypes: true,
});
addFormats(ajv);
for (const file of globSync("common/*.yaml", { cwd: SCHEMAS })) {
  ajv.addSchema(loadSchema(file), file);
}
const validatePlugin = ajv.compile(loadSchema("custom_viz_plugin.yaml"));
const validateCard = ajv.compile(loadSchema("card.yaml"));

// The example entity in the spec's Custom Viz Plugin section.
const PLUGIN = {
  identifier: "thumbs",
  enabled: true,
  "serdes/meta": [{ model: "CustomVizPlugin", id: "thumbs", label: "thumbs" }],
};

describe("custom viz plugin schema", () => {
  it.each([
    ["the spec's example", PLUGIN],
    [
      "only the required fields",
      {
        identifier: "thumbs",
        "serdes/meta": [{ model: "CustomVizPlugin" }],
      },
    ],
    [
      "an identifier with dots and dashes",
      { ...PLUGIN, identifier: "acme.viz-2" },
    ],
    ["a creation timestamp", { ...PLUGIN, created_at: "2026-04-02T01:50:04Z" }],
  ])("accepts %s", (_, plugin) => {
    expect(validatePlugin(plugin), JSON.stringify(validatePlugin.errors)).toBe(
      true,
    );
  });

  const without = (key: keyof typeof PLUGIN) => {
    const { [key]: _removed, ...plugin } = PLUGIN;
    return plugin;
  };

  it.each([
    ["no identifier", without("identifier")],
    ["an empty identifier", { ...PLUGIN, identifier: "" }],
    ["an identifier with a colon", { ...PLUGIN, identifier: "acme:thumbs" }],
    ["an identifier with a slash", { ...PLUGIN, identifier: "acme/thumbs" }],
    [
      "an identifier with a backslash",
      { ...PLUGIN, identifier: "acme\\thumbs" },
    ],
    ["an identifier with a space", { ...PLUGIN, identifier: "sun burst" }],
    ["an identifier starting with a dot", { ...PLUGIN, identifier: ".thumbs" }],
    ["no serdes/meta", without("serdes/meta")],
    [
      "serdes/meta of another model",
      { ...PLUGIN, "serdes/meta": [{ model: "DataApp", id: "thumbs" }] },
    ],
    [
      "two serdes/meta entries",
      {
        ...PLUGIN,
        "serdes/meta": [
          { model: "CustomVizPlugin" },
          { model: "CustomVizPlugin" },
        ],
      },
    ],
    ["enabled that isn't a boolean", { ...PLUGIN, enabled: "yes" }],
    [
      "a created_at that isn't a timestamp",
      { ...PLUGIN, created_at: "yesterday" },
    ],
  ])("rejects %s", (_, plugin) => {
    expect(validatePlugin(plugin)).toBe(false);
  });
});

describe("card display", () => {
  const CARD = {
    name: "Orders",
    entity_id: "cUsToMvIzCaRd0ExAmP12",
    creator_id: "admin@example.com",
    display: "table",
    dataset_query: {
      "lib/type": "mbql/query",
      database: "Sample Database",
      stages: [
        {
          "lib/type": "mbql.stage/mbql",
          "source-table": ["Sample Database", "PUBLIC", "ORDERS"],
        },
      ],
    },
    visualization_settings: {},
    "serdes/meta": [{ model: "Card" }],
  };

  it.each([
    ["a built-in display type", "bar"],
    ["a custom visualization", "custom:thumbs"],
    ["a custom visualization with dots and dashes", "custom:acme.viz-2"],
  ])("accepts %s", (_, display) => {
    const card = { ...CARD, display };
    expect(validateCard(card), JSON.stringify(validateCard.errors)).toBe(true);
  });

  it.each([
    ["an unknown display type", "thumbs"],
    ["a custom prefix with no identifier", "custom:"],
    ["a custom identifier with a colon", "custom:acme:thumbs"],
  ])("rejects %s", (_, display) => {
    expect(validateCard({ ...CARD, display })).toBe(false);
  });
});
