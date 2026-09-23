import { describe, expect, test } from "bun:test";
import { lineDiff, parseJsonc, planExclude, toValue } from "./init-tsconfig.ts";

const NEXT = `{
  "compilerOptions": {
    "target": "ES2017",
    "strict": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`;

function edited(text: string) {
  const plan = planExclude(text);
  expect(plan.status).toBe("needed");
  return { plan, after: plan.after!, value: toValue(parseJsonc(plan.after!)) as { exclude: string[] } };
}

describe("planExclude", () => {
  test("a Next.js tsconfig: one line changes, every other byte stays", () => {
    const { plan, after, value } = edited(NEXT);
    expect(after).toBe(NEXT.replace(`"exclude": ["node_modules"]`, `"exclude": ["node_modules", "data"]`));
    expect(value.exclude).toEqual(["node_modules", "data"]);
    expect(plan.diff).toBe([
      "--- tsconfig.json",
      "+++ tsconfig.json",
      "@@ line 8 @@",
      `-  "exclude": ["node_modules"]`,
      `+  "exclude": ["node_modules", "data"]`,
    ].join("\n"));
  });

  test("no exclude: adds one that keeps node_modules excluded", () => {
    const { after, value } = edited(`{\n  "compilerOptions": { "strict": true }\n}\n`);
    expect(after).toBe(`{\n  "compilerOptions": { "strict": true },\n  "exclude": ["node_modules", "data"]\n}\n`);
    expect(value.exclude).toEqual(["node_modules", "data"]);
  });

  test("multi-line arrays keep their indentation, with or without a trailing comma", () => {
    const multi = `{\n    "exclude": [\n        "node_modules",\n        "dist"\n    ]\n}\n`;
    expect(edited(multi).after).toBe(`{\n    "exclude": [\n        "node_modules",\n        "dist",\n        "data"\n    ]\n}\n`);
    const trailing = `{\n  "exclude": [\n    "node_modules",\n  ],\n}\n`;
    const t = edited(trailing);
    expect(t.after).toBe(`{\n  "exclude": [\n    "node_modules",\n    "data",\n  ],\n}\n`);
    expect(t.value.exclude).toEqual(["node_modules", "data"]);
  });

  test("comments survive (JSONC)", () => {
    const text = `// app config\n{\n  /* compiler */\n  "compilerOptions": {}, // trailing note\n  "exclude": [] // none yet\n}\n`;
    const { after, value } = edited(text);
    expect(after).toBe(`// app config\n{\n  /* compiler */\n  "compilerOptions": {}, // trailing note\n  "exclude": ["data"] // none yet\n}\n`);
    expect(value.exclude).toEqual(["data"]);
  });

  test("a trailing comma after the last property stays", () => {
    const { after, value } = edited(`{\n  "compilerOptions": {},\n}\n`);
    expect(after).toBe(`{\n  "compilerOptions": {},\n  "exclude": ["node_modules", "data"],\n}\n`);
    expect(value.exclude).toEqual(["node_modules", "data"]);
  });

  test("not needed when data is already excluded or not included at all", () => {
    for (const ex of [`"data"`, `"./data"`, `"data/"`, `"data/**"`, `"data/**/*"`]) {
      expect(planExclude(`{"exclude": ["node_modules", ${ex}]}`).status).toBe("not_needed");
    }
    expect(planExclude(`{"include": ["src", "next-env.d.ts", "*.ts"]}`)).toMatchObject({ status: "not_needed" });
    expect(planExclude(`{"files": ["index.ts"]}`)).toMatchObject({ status: "not_needed" });
    // Patterns that do reach data/.
    for (const inc of [`"**/*.ts"`, `"."`, `"data"`, `"d*/**/*.ts"`, `"./**/*"`]) {
      expect(planExclude(`{"include": [${inc}]}`).status).toBe("needed");
    }
    expect(planExclude(`{"extends": "./base.json", "files": ["a.ts"]}`).status).toBe("needed");
  });

  test("manual when the file cannot be edited safely", () => {
    expect(planExclude(`{"exclude": "node_modules"}`).status).toBe("manual");
    expect(planExclude(`{"exclude": [}`).status).toBe("manual");
    expect(planExclude(`[1, 2]`).status).toBe("manual");
    expect(planExclude(`{/* never closed`).status).toBe("manual");
  });

  test("a single-line object gets an inline property", () => {
    expect(edited(`{"compilerOptions": {}}`).after).toBe(`{"compilerOptions": {}, "exclude": ["node_modules", "data"]}`);
    expect(edited(`{}`).value.exclude).toEqual(["node_modules", "data"]);
  });
});

describe("parseJsonc", () => {
  test("values, escapes, BOM and spans", () => {
    const text = `﻿{"a": [1, -2.5e3, true, null, "x\\"y"], "b": {"c": "d"},}`;
    expect(toValue(parseJsonc(text))).toEqual({ a: [1, -2500, true, null, 'x"y'], b: { c: "d" } });
    const root = parseJsonc(`{"k": [1]}`);
    expect(root.type === "object" && root.props[0]!.value).toMatchObject({ type: "array", start: 6, end: 9 });
  });

  test("errors", () => {
    for (const bad of [`{"a" 1}`, `{"a": 1 "b": 2}`, `{"a": [1 2]}`, `{"a": "x`, `{a: 1}`, `{"a": 1} x`, `{"a": nope}`]) {
      expect(() => parseJsonc(bad)).toThrow();
    }
  });
});

test("lineDiff shows only the changed region", () => {
  expect(lineDiff("f", "a\nb\nc\n", "a\nB\nc\n")).toBe("--- f\n+++ f\n@@ line 2 @@\n-b\n+B");
  expect(lineDiff("f", "a\n", "a\nx\n")).toBe("--- f\n+++ f\n@@ line 2 @@\n+x");
});
