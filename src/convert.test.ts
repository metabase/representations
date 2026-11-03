import { describe, expect, it } from "bun:test";

import {
  getInstanceEntity,
  getPortableEntity,
  getPortableIds,
  getPortableRefs,
  mergePortableRefs,
  portableKey,
  validateInstance,
  validatePortable,
  withoutPortableRefs,
  type Kind,
  type PortableEntity,
  type PortableRefs,
  type PortableToInstance,
} from "./index.js";
import {
  readExamples,
  readInstanceIds,
  toPortableRefsMap,
} from "./test-support/examples.js";

interface Item {
  file: string;
  kind: Kind;
  entity: PortableEntity;
}

const ITEMS: Item[] = readExamples().map(({ file, kind, document }) => {
  const validation = validatePortable(kind, document);
  if (!validation.ok) {
    throw new Error(`${file}: ${JSON.stringify(validation.issues)}`);
  }
  return { file, kind, entity: validation.value };
});

const EXTERNAL_IDS = readInstanceIds();

const OWN_IDS = mergePortableRefs(
  ...ITEMS.map(({ kind, entity }) => getPortableIds(kind, entity)),
);

const INSTANCE_IDS: PortableToInstance = {
  ...EXTERNAL_IDS,
  ...Object.fromEntries(
    Object.entries(OWN_IDS).map(([model, refs]) => [
      model,
      Object.fromEntries(
        refs.map((ref, index) => [portableKey(ref), index + 1]),
      ),
    ]),
  ),
};

const PORTABLE_REFS = toPortableRefsMap(INSTANCE_IDS);

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
    const refs = mergePortableRefs(
      ...ITEMS.map(({ kind, entity }) => getPortableRefs(kind, entity)),
    );

    expect(keysByModel(withoutPortableRefs(refs, OWN_IDS))).toEqual(
      keysByModel(EXTERNAL_IDS),
    );
  });
});

describe("getInstanceEntity and getPortableEntity", () => {
  it.each(ITEMS.map((item) => [item.file, item] as const))(
    "convert %s to valid instance entity and back unchanged",
    (_file, { kind, entity }) => {
      const instance = getInstanceEntity(kind, entity, INSTANCE_IDS);
      if (!instance.ok) {
        throw new Error(JSON.stringify(instance.unresolved));
      }
      const validation = validateInstance(kind, instance.value);

      expect(validation.ok ? [] : validation.issues).toEqual([]);
      expect(getPortableEntity(kind, instance.value, PORTABLE_REFS)).toEqual({
        ok: true,
        value: entity,
      });
    },
  );
});
