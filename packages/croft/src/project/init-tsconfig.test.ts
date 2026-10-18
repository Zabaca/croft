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
const TYPES = "data/.croft/types/**/*.d.ts";
const SKIPPED = ["data/assets", "data/lib"];

function edited(text: string) {
  const plan = planExclude(text);
  expect(plan.status).toBe("needed");
  return { plan, after: plan.after!, value: toValue(parseJsonc(plan.after!)) as Record<string, unknown> & { exclude?: string[]; include?: string[] } };
}

describe("planExclude: skip the project's Bun-only folders, include its row types", () => {
  test("a Next.js tsconfig: two lines change, every other byte stays", () => {
    const { plan, after, value } = edited(NEXT);
    expect(after).toBe(NEXT
      .replace(`".next/types/**/*.ts"]`, `".next/types/**/*.ts", "${TYPES}"]`)
      .replace(`"exclude": ["node_modules"]`, `"exclude": ["node_modules", "data/assets", "data/lib"]`));
    expect(value.exclude).toEqual(["node_modules", ...SKIPPED]);
    expect(value.include).toContain(TYPES);
    expect(plan.diff).toBe([
      "--- tsconfig.json",
      "+++ tsconfig.json",
      "@@ line 7 @@",
      `-  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],`,
      `-  "exclude": ["node_modules"]`,
      `+  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", "${TYPES}"],`,
      `+  "exclude": ["node_modules", "data/assets", "data/lib"]`,
    ].join("\n"));
    expect(plan.reason).toBe(`tsconfig.json would type-check data/'s pipelines, which need Bun's types, and would not see data/'s table types, which type query<"table">()`);
  });

  test("no include and no exclude: TypeScript's defaults are written out, node_modules kept excluded", () => {
    const { after, value } = edited(`{\n  "compilerOptions": { "strict": true }\n}\n`);
    expect(after).toBe(`{\n  "compilerOptions": { "strict": true },\n  "exclude": ["node_modules", "data/assets", "data/lib"],\n  "include": ["**/*", "${TYPES}"]\n}\n`);
    expect(value).toMatchObject({ exclude: ["node_modules", ...SKIPPED], include: ["**/*", TYPES] });
  });

  test("multi-line arrays keep their indentation, with or without a trailing comma", () => {
    const multi = `{\n    "include": ["src"],\n    "exclude": [\n        "node_modules",\n        "dist"\n    ]\n}\n`;
    // src/ does not reach data/: only the types are added.
    expect(edited(multi).after).toBe(`{\n    "include": ["src", "${TYPES}"],\n    "exclude": [\n        "node_modules",\n        "dist"\n    ]\n}\n`);
    const trailing = `{\n  "include": [\n    "**/*",\n  ],\n  "exclude": [\n    "node_modules",\n  ],\n}\n`;
    const t = edited(trailing);
    expect(t.after).toBe(`{\n  "include": [\n    "**/*",\n    "${TYPES}",\n  ],\n  "exclude": [\n    "node_modules",\n    "data/assets",\n    "data/lib",\n  ],\n}\n`);
    expect(t.value).toEqual({ include: ["**/*", TYPES], exclude: ["node_modules", ...SKIPPED] });
  });

  test("comments survive (JSONC)", () => {
    const text = `// app config\n{\n  /* compiler */\n  "compilerOptions": {}, // trailing note\n  "include": ["**/*.ts"], // ours\n  "exclude": [] // none yet\n}\n`;
    const { after, value } = edited(text);
    expect(after).toBe(`// app config\n{\n  /* compiler */\n  "compilerOptions": {}, // trailing note\n  "include": ["**/*.ts", "${TYPES}"], // ours\n  "exclude": ["data/assets", "data/lib"] // none yet\n}\n`);
    expect(value).toEqual({ compilerOptions: {}, include: ["**/*.ts", TYPES], exclude: ["data/assets", "data/lib"] });
  });

  test("a trailing comma after the last property stays", () => {
    const { after } = edited(`{\n  "compilerOptions": {},\n}\n`);
    expect(after).toBe(`{\n  "compilerOptions": {},\n  "exclude": ["node_modules", "data/assets", "data/lib"],\n  "include": ["**/*", "${TYPES}"],\n}\n`);
  });

  test("only what is missing is added; nothing when all of it is there", () => {
    const half = edited(`{"include": ["**/*", "${TYPES}"], "exclude": ["node_modules", "data/assets"]}`);
    expect(half.value).toEqual({ include: ["**/*", TYPES], exclude: ["node_modules", "data/assets", "data/lib"] });
    expect(half.plan.reason).toBe("tsconfig.json would type-check data/'s pipelines, which need Bun's types");
    expect(planExclude(`{"include": ["**/*", "${TYPES}"], "exclude": ["data/assets/**", "data/lib"]}`).status).toBe("not_needed");
    // An include that never reaches data/ needs no exclusion, only the types.
    for (const inc of [`"src"`, `"next-env.d.ts"`, `"*.ts"`]) {
      const e = edited(`{"include": [${inc}]}`);
      expect(e.value).toEqual({ include: [JSON.parse(inc), TYPES] });
    }
    // Patterns that do reach data/.
    for (const inc of [`"**/*.ts"`, `"."`, `"data"`, `"d*/**/*.ts"`, `"./**/*"`]) {
      expect(edited(`{"include": [${inc}]}`).value.exclude).toEqual(["node_modules", ...SKIPPED]);
    }
    // "files" alone reaches nothing else: the types get an "include" of their own.
    expect(edited(`{"files": ["index.ts"]}`).value).toEqual({ files: ["index.ts"], include: [TYPES] });
  });

  test("an app that excludes all of data/ already: the types are left to the user, with the edit", () => {
    for (const ex of [`"data"`, `"./data"`, `"data/"`, `"data/**"`, `"data/**/*"`]) {
      const p = planExclude(`{"exclude": ["node_modules", ${ex}]}`);
      expect(p.status).toBe("manual");
      expect(p.reason).toContain(`replace "data" in its "exclude" with "data/assets" and "data/lib", and add "${TYPES}"`);
    }
  });

  test("extends: the base may set its own include, so a new one is not written; the exclusion still is", () => {
    const e = edited(`{"extends": "./base.json"}`);
    expect(e.value).toEqual({ extends: "./base.json", exclude: ["node_modules", ...SKIPPED] });
    expect(e.plan.reason).toContain(`add "${TYPES}" to its "include" by hand (it extends another config)`);
    // With an include of its own, it is edited as usual.
    expect(edited(`{"extends": "./base.json", "include": ["src"]}`).value.include).toEqual(["src", TYPES]);
  });

  test("manual when the file cannot be edited safely", () => {
    expect(planExclude(`{"exclude": "node_modules"}`).status).toBe("manual");
    expect(planExclude(`{"include": "src"}`).status).toBe("manual");
    expect(planExclude(`{"exclude": [}`).status).toBe("manual");
    expect(planExclude(`[1, 2]`).status).toBe("manual");
    expect(planExclude(`{/* never closed`).status).toBe("manual");
  });

  test("a single-line object gets inline properties", () => {
    expect(edited(`{"compilerOptions": {}}`).after)
      .toBe(`{"compilerOptions": {}, "exclude": ["node_modules", "data/assets", "data/lib"], "include": ["**/*", "${TYPES}"]}`);
    expect(edited(`{}`).value).toEqual({ exclude: ["node_modules", ...SKIPPED], include: ["**/*", TYPES] });
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
