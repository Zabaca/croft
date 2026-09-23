import { describe, expect, test } from "bun:test";
import { didYouMean, editDistance } from "./suggest.ts";

const COMMANDS = ["init", "doctor", "new", "secrets", "docs", "context", "status", "describe", "query", "logs",
  "validate", "preview", "run", "wait", "confirm", "rename", "delete", "restore", "schedule", "serve", "help", "version"];

describe("editDistance", () => {
  test("insertions, deletions, substitutions and transpositions", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("stauts", "status")).toBe(1);
    expect(editDistance("ab", "ba")).toBe(1);
  });
});

describe("didYouMean", () => {
  test("common command typos", () => {
    expect(didYouMean("stauts", COMMANDS)).toBe("status");
    expect(didYouMean("valdiate", COMMANDS)).toBe("validate");
    expect(didYouMean("qeury", COMMANDS)).toBe("query");
    expect(didYouMean("confrim", COMMANDS)).toBe("confirm");
    expect(didYouMean("serv", COMMANDS)).toBe("serve");
    expect(didYouMean("doc", COMMANDS)).toBe("docs");
  });

  test("case differences and unique prefixes", () => {
    expect(didYouMean("timeZone", ["timezone", "database"])).toBe("timezone");
    expect(didYouMean("sched", COMMANDS)).toBe("schedule");
  });

  test("returns nothing for unrelated input", () => {
    expect(didYouMean("deploy", COMMANDS)).toBeUndefined();
    expect(didYouMean("xyz", COMMANDS)).toBeUndefined();
    expect(didYouMean("", COMMANDS)).toBeUndefined();
  });
});
