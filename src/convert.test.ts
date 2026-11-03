import { describe, expect, it } from "bun:test";

import {
  getInstanceEntities,
  getPortableEntities,
  getPortableRefs,
  portableKey,
  validateInstance,
  validatePortable,
  type InstanceItem,
  type PortableItem,
  type PortableRefs,
  type PortableToInstance,
} from "./index.js";
import {
  readExamples,
  readInstanceIds,
  toPortableRefsMap,
} from "./test-support/examples.js";

const EXAMPLES = readExamples();
const INSTANCE_IDS = readInstanceIds();
const PORTABLE_REFS = toPortableRefsMap(INSTANCE_IDS);

const PORTABLE_ITEMS: PortableItem[] = EXAMPLES.map(({ kind, document }) => {
  const validation = validatePortable(kind, document);
  if (!validation.ok) {
    throw new Error(JSON.stringify(validation.issues));
  }
  return { kind, entity: validation.value };
});

const INSTANCE_ITEMS: InstanceItem[] = (() => {
  const conversion = getInstanceEntities(PORTABLE_ITEMS, INSTANCE_IDS);
  if (!conversion.ok) {
    throw new Error(JSON.stringify(conversion.unresolved));
  }
  return conversion.value;
})();

function keysByModel(refs: PortableRefs | PortableToInstance) {
  return Object.fromEntries(
    Object.entries(refs).map(([model, modelRefs]) => [
      model,
      (Array.isArray(modelRefs)
        ? modelRefs.map(portableKey)
        : Object.keys(modelRefs)
      ).sort(),
    ]),
  );
}

describe("getPortableRefs", () => {
  it("collects references outside examples, which instance ids file lists", () => {
    expect(keysByModel(getPortableRefs(PORTABLE_ITEMS))).toEqual(
      keysByModel(INSTANCE_IDS),
    );
  });
});

describe("getInstanceEntities", () => {
  it.each(
    INSTANCE_ITEMS.map((item, index) => [EXAMPLES[index].file, item] as const),
  )("converts %s to valid instance entity", (_file, { kind, entity }) => {
    const validation = validateInstance(kind, entity);

    expect(validation.ok ? [] : validation.issues).toEqual([]);
  });
});

describe("getPortableEntities", () => {
  it("converts instance entities of examples back unchanged", () => {
    expect(getPortableEntities(INSTANCE_ITEMS, PORTABLE_REFS)).toEqual({
      ok: true,
      value: PORTABLE_ITEMS,
    });
  });
});
