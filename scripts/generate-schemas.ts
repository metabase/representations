import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const SCHEMAS_DIR = resolve(import.meta.dirname, "../core-spec/v1/schemas");

const MODEL_SCHEMAS: Record<string, string> = {
  Action: ":metabase.actions.schema/external-action",
  Card: ":metabase.queries.schema/external-card",
  CardTest: ":metabase-enterprise.data-testing.schema/external-card-test",
  Channel: ":metabase.channel.schema/external-channel",
  Collection: ":metabase.collections.schema/external-collection",
  CustomVizPlugin:
    ":metabase-enterprise.custom-viz-plugin.schema/external-custom-viz-plugin",
  Dashboard: ":metabase.dashboards.schema/external-dashboard",
  DataApp: ":metabase.data-apps.schema/external-data-app",
  Database: ":metabase.warehouses.schema/external-database",
  Dimension: ":metabase.warehouse-schema.schema/external-dimension",
  Document: ":metabase.documents.schema/external-document",
  EmbeddingTheme: ":metabase.embedding.schema/external-embedding-theme",
  Field: ":metabase.warehouse-schema.schema/external-field",
  FieldUserSettings:
    ":metabase.warehouse-schema.schema/external-field-user-settings",
  FieldValues: ":metabase.warehouse-schema.schema/external-field-values",
  Glossary: ":metabase.glossary.schema/external-glossary",
  Measure: ":metabase.measures.schema/external-measure",
  Metabot: ":metabase.metabot.schema/external-metabot",
  NativeQuerySnippet:
    ":metabase.native-query-snippets.schema/external-native-query-snippet",
  OsiAiContext: ":metabase.osi.schema/external-osi-ai-context",
  PythonLibrary:
    ":metabase-enterprise.transforms-python.schema/external-python-library",
  Segment: ":metabase.segments.schema/external-segment",
  SegmentTest: ":metabase-enterprise.data-testing.schema/external-segment-test",
  Setting: ":metabase.settings.schema/external-setting",
  Table: ":metabase.warehouse-schema.schema/external-table",
  TableUserSettings:
    ":metabase.warehouse-schema.schema/external-table-user-settings",
  Timeline: ":metabase.timeline.schema/external-timeline",
  Transform: ":metabase.transforms.schema/external-transform",
  TransformJob: ":metabase.transforms.schema/external-transform-job",
  TransformTag: ":metabase.transforms.schema/external-transform-tag",
  TransformTest:
    ":metabase-enterprise.data-testing.schema/external-transform-test",
};

const { values } = parseArgs({
  options: {
    metabase: { type: "string" },
    port: { type: "string" },
  },
});

if (!values.metabase) {
  console.error(
    "Usage: bun run generate-schemas --metabase <path to a metabase checkout> [--port <nREPL port>]",
  );
  process.exit(1);
}

const metabase = resolve(values.metabase);
const portArgs = values.port ? ["--port", values.port] : [];

const json = execFileSync(
  "./bin/mage",
  ["print-json-schema", ...portArgs, ...Object.values(MODEL_SCHEMAS)],
  { cwd: metabase, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);
const { properties, ...schema } = JSON.parse(json);

rmSync(SCHEMAS_DIR, { recursive: true, force: true });
mkdirSync(SCHEMAS_DIR, { recursive: true });
writeFileSync(
  resolve(SCHEMAS_DIR, "schema.json"),
  `${JSON.stringify(
    {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(MODEL_SCHEMAS).map(([model, keyword]) => [
          model,
          properties[keyword.slice(1)],
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);
