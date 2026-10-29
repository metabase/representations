import { describe, expect, it } from "bun:test";

import { errorMessage } from "./values.js";

describe("errorMessage", () => {
  it("gives an Error's message", () => {
    expect(errorMessage(new TypeError("bad input"))).toBe("bad input");
  });

  it("gives any other thrown value as text", () => {
    expect(errorMessage("bad input")).toBe("bad input");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
