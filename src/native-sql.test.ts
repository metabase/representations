import { describe, expect, it } from "bun:test";

import { type NativePart, parseNativeSql } from "./native-sql.js";

const text = (t: string): NativePart => ({ type: "text", text: t });
const tag = (name: string): NativePart => ({ type: "tag", name });

describe("parseNativeSql", () => {
  it("reads a tag as the last two braces of a run, as Metabase's tokenizer does", () => {
    expect(parseNativeSql("{{{x}}}")).toEqual({
      status: "parsed",
      parts: [text("{"), tag("x"), text("}")],
    });
  });

  it("reads */* as a comment's start, as Metabase splits /* before */", () => {
    expect(parseNativeSql("a */* {{x}} */ {{y}}")).toEqual({
      status: "parsed",
      parts: [text("a */* {{x}} */ "), tag("y")],
    });
  });

  it("reads a comment start inside an optional clause or a string as text", () => {
    expect(parseNativeSql("[[ -- {{x}} ]] '/*' {{y}}")).toEqual({
      status: "parsed",
      parts: [
        { type: "optional", parts: [text(" -- "), tag("x"), text(" ")] },
        text(" '/*' "),
        tag("y"),
      ],
    });
  });

  it("ends a line comment at a newline", () => {
    expect(parseNativeSql("-- {{x}}\n{{y}}")).toEqual({
      status: "parsed",
      parts: [text("-- {{x}}\n"), tag("y")],
    });
  });

  it("refuses an empty tag and a tag with a tag in it", () => {
    expect(parseNativeSql("{{ }}")).toEqual({
      status: "unread",
      reason:
        "Metabase cannot parse its template tags: '{{...}}' clauses cannot be empty.",
    });
    expect(parseNativeSql("{{a {{b}} }}")).toEqual({
      status: "unread",
      reason:
        "Metabase cannot parse its template tags: Invalid '{{...}}' clause: expected a param name",
    });
  });
});
