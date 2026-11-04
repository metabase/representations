import { describe, expect, it } from "bun:test";
import type { z } from "zod";

import {
  getPortableModel,
  PortableAction,
  PortableCard,
  PortableChannel,
  PortableCollection,
  PortableDashboard,
  PortableDataApp,
  PortableDatabase,
  PortableDocument,
  PortableField,
  PortableFieldUserSettings,
  PortableFieldValues,
  PortableGlossary,
  PortableMeasure,
  PortableMetabot,
  PortableNativeQuerySnippet,
  PortablePythonLibrary,
  PortableSegment,
  PortableTable,
  PortableTimeline,
  PortableTransform,
  PortableTransformJob,
  PortableTransformTag,
  PortableTransformTest,
} from "./index.js";
import { readExamples } from "./test-support/examples.js";

const PORTABLE_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  Action: PortableAction,
  Card: PortableCard,
  Channel: PortableChannel,
  Collection: PortableCollection,
  Dashboard: PortableDashboard,
  DataApp: PortableDataApp,
  Database: PortableDatabase,
  Document: PortableDocument,
  Field: PortableField,
  FieldUserSettings: PortableFieldUserSettings,
  FieldValues: PortableFieldValues,
  Glossary: PortableGlossary,
  Measure: PortableMeasure,
  Metabot: PortableMetabot,
  NativeQuerySnippet: PortableNativeQuerySnippet,
  PythonLibrary: PortablePythonLibrary,
  Segment: PortableSegment,
  Table: PortableTable,
  Timeline: PortableTimeline,
  Transform: PortableTransform,
  TransformJob: PortableTransformJob,
  TransformTag: PortableTransformTag,
  TransformTest: PortableTransformTest,
};

describe("portable schemas", () => {
  it.each(readExamples().map((example) => [example.file, example] as const))(
    "accept %s",
    (_file, { document }) => {
      const model = getPortableModel(document);
      const schema = model === null ? undefined : PORTABLE_SCHEMAS[model];
      if (schema === undefined) {
        throw new Error(`no portable schema for model ${model}`);
      }
      const result = schema.safeParse(document);

      expect(result.success ? [] : result.error.issues).toEqual([]);
    },
  );
});
