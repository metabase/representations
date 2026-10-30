import { describe, expect, it } from "bun:test";

import { type Doc, indexByEntityId } from "./documents.js";
import { createSnippetFinder } from "./reads.js";

const SNIPPET_ID = "SnippetId000000000001";

function doc(file: string, model: string, body: Record<string, unknown>): Doc {
  return {
    file,
    model,
    schema: { status: "passed" },
    nonStringKeys: [],
    body: { entity_id: SNIPPET_ID, ...body, "serdes/meta": [{ model }] },
  };
}

const snippet = doc("snippets/filter.yaml", "NativeQuerySnippet", {
  name: "filter",
  content: "status = 'active'",
});

// Sorts before the snippet's file.
const transform = doc("collections/a_transform.yaml", "Transform", {
  name: "A transform",
});

describe("createSnippetFinder", () => {
  const find = (docs: readonly Doc[]) =>
    createSnippetFinder(docs, indexByEntityId(docs))("filter", SNIPPET_ID);

  it("finds a snippet by id where a file of another model shares the id", () => {
    expect(find([transform, snippet])).toEqual({
      content: "status = 'active'",
    });
  });

  it("names the other model when no snippet holds the id", () => {
    expect(find([transform])).toEqual({
      unusable: `snippet filter (${SNIPPET_ID}) names a Transform, not a snippet`,
    });
  });

  it("takes the last snippet file in path order of two with one id", () => {
    const later = doc("snippets/filter_copy.yaml", "NativeQuerySnippet", {
      name: "filter",
      content: "status = 'closed'",
    });
    expect(find([snippet, later])).toEqual({ content: "status = 'closed'" });
  });
});
