import { describe, expect, it } from "bun:test";

import { validatePortable } from "./index.js";
import { readExamples } from "./test-support/examples.js";

describe("validatePortable", () => {
  it.each(readExamples().map((example) => [example.file, example] as const))(
    "accepts %s",
    (_file, { kind, document }) => {
      const validation = validatePortable(kind, document);

      expect(validation.ok ? [] : validation.issues).toEqual([]);
    },
  );
});
