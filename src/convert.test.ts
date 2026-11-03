import { describe, expect, it } from "bun:test";

import {
  getInstanceEntity,
  getPortableEntity,
  getPortableRefs,
  mergePortableRefs,
  portableKey,
  validateInstance,
  validatePortable,
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

const EXAMPLES = readExamples();
const INSTANCE_IDS = readInstanceIds();
const PORTABLE_REFS = toPortableRefsMap(INSTANCE_IDS);

function validPortable<K extends Kind>(
  kind: K,
  document: unknown,
): PortableEntity<K> {
  const validation = validatePortable(kind, document);
  if (!validation.ok) {
    throw new Error(JSON.stringify(validation.issues));
  }
  return validation.value;
}

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
  it("collects every reference of instance ids file, and no other", () => {
    const refs = mergePortableRefs(
      ...EXAMPLES.map(({ kind, document }) =>
        getPortableRefs(kind, validPortable(kind, document)),
      ),
    );

    expect(keysByModel(refs)).toEqual(keysByModel(INSTANCE_IDS));
  });
});

describe("getInstanceEntity and getPortableEntity", () => {
  it.each(EXAMPLES.map((example) => [example.file, example] as const))(
    "convert %s to valid instance entity and back unchanged",
    (_file, { kind, document }) => {
      const portable = validPortable(kind, document);

      const instance = getInstanceEntity(kind, portable, INSTANCE_IDS);
      if (!instance.ok) {
        throw new Error(JSON.stringify(instance.unresolved));
      }
      const validation = validateInstance(kind, instance.value);

      expect(validation.ok ? [] : validation.issues).toEqual([]);
      expect(getPortableEntity(kind, instance.value, PORTABLE_REFS)).toEqual({
        ok: true,
        value: portable,
      });
    },
  );
});
