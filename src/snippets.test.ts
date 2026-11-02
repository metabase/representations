import { describe, expect, it } from "bun:test";

import {
  expandSnippets,
  snippetIdsOf,
  type SnippetLookup,
} from "./snippets.js";

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

  it("leaves a snippet tag inside a SQL comment as text, as Metabase parses it", () => {
    expect(
      expandSnippets(
        "SELECT * FROM t -- {{snippet: gone}}\nWHERE {{snippet: A}} /* {{snippet: B}} */",
        lookupIn({ A: "x = 1" }),
      ),
    ).toEqual({
      status: "expanded",
      sql: "SELECT * FROM t -- {{snippet: gone}}\nWHERE x = 1 /* {{snippet: B}} */",
    });
  });

  it("keeps the other tags and optional clauses as written", () => {
    const sql = "SELECT * FROM t [[WHERE x = {{ x }} AND {{snippet: A}}]]";
    expect(expandSnippets(sql, lookupIn({ A: "y = 1" }))).toEqual({
      status: "expanded",
      sql: "SELECT * FROM t [[WHERE x = {{ x }} AND y = 1]]",
    });
  });

  it("drops the brackets of an optional clause left with no tag of its own, which Metabase keeps", () => {
    expect(
      expandSnippets(
        "SELECT * FROM t [[WHERE {{snippet: A}}]] [[AND {{snippet: B}}]]",
        lookupIn({ A: "y = 1 [[AND z = {{z}}]]", B: "{{ w }} = 1" }),
      ),
    ).toEqual({
      status: "expanded",
      sql: "SELECT * FROM t WHERE y = 1 [[AND z = {{z}}]] [[AND {{ w }} = 1]]",
    });
  });

  it("leaves as written a snippet no template tag defines, which keeps its clause's brackets", () => {
    expect(
      expandSnippets("SELECT * FROM t [[WHERE {{snippet: A}}]]", () => null),
    ).toEqual({
      status: "expanded",
      sql: "SELECT * FROM t [[WHERE {{snippet: A}}]]",
    });
  });

  it("is unread at a snippet it cannot paste inside an optional clause", () => {
    expect(
      expandSnippets("SELECT * FROM t [[{{snippet: A}}]]", () => ({
        unusable: "snippet A (A1) is not in the folder",
      })),
    ).toEqual({
      status: "unread",
      reason: "snippet A (A1) is not in the folder",
    });
  });

  it("counts an optional clause that loses its brackets at its pasted length", () => {
    const head = "SELECT 1 ".padEnd(9_999_997, " ");
    const expanded = expandSnippets(
      `${head}[[{{snippet: A}}]]`,
      lookupIn({ A: "1" }),
    );
    expect(expanded.status).toBe("expanded");
    expect(expanded.status === "expanded" && expanded.sql.length).toBe(
      9_999_998,
    );
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

  it("refuses the 10,001st paste exactly", () => {
    // Ten uses of Mid, each using Leaf 999 times, and one more use of Leaf.
    const snippets = lookupIn({ Mid: uses("Leaf", 999), Leaf: "1" });
    expect(
      expandSnippets(`${uses("Mid", 10)} AND {{snippet: Leaf}}`, snippets),
    ).toEqual({
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

describe("snippetIdsOf", () => {
  it("keys each snippet id by the name a SQL tag uses, as Metabase reads it", () => {
    const tag = (name: string, id: string) => ({
      name,
      type: "snippet",
      "snippet-id": id,
    });
    expect(
      snippetIdsOf([
        tag("snippet:  Big Orders  ", "id-1"),
        tag("snippet: ", "id-2"),
        tag("snippet: a}b", "id-3"),
        { name: "snippet: x", type: "text", "snippet-id": "id-4" },
      ]),
    ).toEqual(new Map([["Big Orders", "id-1"]]));
  });
});
