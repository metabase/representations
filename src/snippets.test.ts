import { describe, expect, it } from "bun:test";

import { expandSnippets, type SnippetLookup } from "./snippets.js";

const lookupIn =
  (contents: Readonly<Record<string, string>>) =>
  (name: string): SnippetLookup =>
    Object.hasOwn(contents, name)
      ? { content: contents[name] }
      : { unusable: `snippet ${name} is not in the folder` };

const uses = (name: string, times: number) =>
  Array.from({ length: times }, () => `{{snippet: ${name}}}`).join(" AND ");

describe("expandSnippets", () => {
  it("pastes snippets at any depth, and a snippet used twice that is not in a cycle", () => {
    // S0 uses S1, ..., S11 uses Leaf: twelve levels.
    const chain = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `S${i}`,
        i < 11 ? `{{snippet: S${i + 1}}}` : "{{snippet: Leaf}}",
      ]),
    );
    const snippets = lookupIn({
      ...chain,
      Leaf: "x = 1",
      Both: "{{snippet: Leaf}} AND {{snippet: Leaf}}",
    });
    expect(
      expandSnippets("WHERE {{snippet: S0}} AND {{snippet: Both}}", snippets),
    ).toEqual({ status: "expanded", sql: "WHERE x = 1 AND x = 1 AND x = 1" });
  });

  it("is unread at the first snippet it cannot paste, pasting depth first", () => {
    expect(
      expandSnippets(
        "{{snippet: A}} {{snippet: Missing}}",
        lookupIn({ A: "{{snippet: Gone}}" }),
      ),
    ).toEqual({
      status: "unread",
      reason: "snippet Gone is not in the folder",
    });
  });

  it("is unread when snippets use each other in a cycle", () => {
    expect(
      expandSnippets(
        "{{snippet: A}}",
        lookupIn({ A: "{{snippet: B}}", B: "x {{snippet: A}}" }),
      ),
    ).toEqual({
      status: "unread",
      reason: "snippets use each other in a cycle: A -> B -> A",
    });
    expect(
      expandSnippets(
        "{{snippet: Loop}}",
        lookupIn({ Loop: "{{snippet: Loop}}" }),
      ),
    ).toEqual({
      status: "unread",
      reason: "snippets use each other in a cycle: Loop -> Loop",
    });
  });

  it("pastes at most 10,000 snippets", () => {
    // Ten uses of Mid, each using Leaf 999 times: 10 + 9,990 = 10,000 pastes.
    const atLimit = lookupIn({ Mid: uses("Leaf", 999), Leaf: "1" });
    const expanded = expandSnippets(uses("Mid", 10), atLimit);
    expect(expanded.status).toBe("expanded");
    // One more use of Leaf in Mid: 10 + 10,000 pastes.
    const overLimit = lookupIn({ Mid: uses("Leaf", 1000), Leaf: "1" });
    expect(expandSnippets(uses("Mid", 10), overLimit)).toEqual({
      status: "unread",
      reason:
        "the query uses more than 10000 snippets, the most Metabase pastes",
    });
  });

  it("is unread when the pasted SQL is longer than 10,000,000 characters", () => {
    const snippets = lookupIn({ Big: "x".repeat(1_000_000) });
    // The query's 1,000,000 characters and nine snippets of 1,000,000 each.
    const atLimit = `${"y".repeat(1_000_000)}${"{{snippet: Big}}".repeat(9)}`;
    const expanded = expandSnippets(atLimit, snippets);
    expect(expanded.status === "expanded" && expanded.sql.length).toBe(
      10_000_000,
    );
    expect(expandSnippets(`${atLimit}z`, snippets)).toEqual({
      status: "unread",
      reason:
        "the query is longer than 10000000 characters with its snippets pasted, the most Metabase runs",
    });
  });

  it("stops at the limit on snippets that would paste a million times", () => {
    // Seven levels, each using the next ten times: 10^6 pastes of S6.
    const snippets = lookupIn({
      ...Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`S${i}`, uses(`S${i + 1}`, 10)]),
      ),
      S6: "1 = 1",
    });
    expect(expandSnippets("{{snippet: S0}}", snippets)).toEqual({
      status: "unread",
      reason:
        "the query uses more than 10000 snippets, the most Metabase pastes",
    });
  });
});
