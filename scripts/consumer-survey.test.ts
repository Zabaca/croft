// The consumer survey's pure core (scripts/consumer-survey.ts). Run from the repo root: bun test scripts/
import { describe, expect, test } from "bun:test";
import {
  addedDependencies,
  assetKind,
  bestOf,
  classify,
  commentText,
  configKeys,
  contextFields,
  findHatches,
  findNotes,
  lockedCroft,
  revision as rev,
  splitClaudeMd,
} from "./consumer-survey.ts";

const skillV1 = "---\nname: croft\n---\n<!-- croft {{version}} -->\n## Orient\nStart with `croft context --json`.\n";
const skillV2 = "---\nname: croft\n---\n<!-- croft {{version}} -->\n## Orient\nStart with `croft context --json`.\n## Loop\n";

describe("classify", () => {
  test("a skill stamped by an old release matches that release's template, not main: stale", () => {
    const written = skillV1.replace("{{version}}", "0.1.0");
    expect(classify(written, [rev("newest", skillV2), rev("older", skillV1)])).toEqual({ verdict: "stale", matchedRev: "older" });
  });

  test("a copy of the newest revision is current, whatever version stamped it", () => {
    expect(classify(skillV2.replace("{{version}}", "0.2.1"), [rev("newest", skillV2), rev("older", skillV1)]))
      .toEqual({ verdict: "current", matchedRev: "newest" });
  });

  test("an edit matches no revision and points at the closest one to diff against", () => {
    const edited = `${skillV1.replace("{{version}}", "0.1.0")}Always run through bin/croft.\n`;
    const c = classify(edited, [rev("newest", skillV2), rev("older", skillV1)]);
    expect(c.verdict).toBe("divergent");
    expect(c.nearestRev).toBe("older");
  });

  test("a reformat is not an edit", () => {
    const ts = `export default ingest({ key: "id" });\n`;
    expect(classify(`export default ingest({ key: 'id' })\r\n\r\n`, [rev("newest", ts)]))
      .toEqual({ verdict: "current", matchedRev: "newest", formattingOnly: true });
  });

  test("a file the consumer deleted is removed, not divergent", () => {
    expect(classify(null, [rev("newest", skillV1)])).toEqual({ verdict: "removed" });
  });
});

describe("bestOf", () => {
  test("a block current for the project template is not called stale by the app template's history", () => {
    expect(bestOf([{ verdict: "divergent", similarity: 0.4 }, { verdict: "current", matchedRev: "a" }])).toEqual({ verdict: "current", matchedRev: "a" });
  });
});

describe("splitClaudeMd", () => {
  const block = "<!-- croft:start (managed by `croft init --claude`) -->\n## Data pipelines (croft)\n<!-- croft:end -->\n";

  test("separates croft's block from what the consumer wrote around it", () => {
    expect(splitClaudeMd(`# SEO\nAlways use bin/croft.\n\n${block}\nMore of ours.\n`))
      .toEqual({ block, outside: "# SEO\nAlways use bin/croft.\n\n\nMore of ours." });
  });

  test("a block at the end of a file without a newline still matches the template", () => {
    expect(splitClaudeMd(block.trimEnd()).block).toBe(block);
  });

  test("no block: everything is the consumer's", () => {
    expect(splitClaudeMd("# notes\n")).toEqual({ block: null, outside: "# notes" });
  });
});

describe("asset shape", () => {
  const asset = `import { transform } from "@zabaca/croft"
export default transform({
  description: "Full opinion text",
  inputs: ["courtlistener_candidates"],
  key: "cluster_id",
  incremental: true,                    // each case is fetched once
  checks: ["not_null(case_name)"],
  columns: { filed: { type: "DATE", format: "%Y" } },
  async *rows({ newRows, http, secret: s, log }) {
    for await (const c of newRows("courtlistener_candidates")) yield { id: 1 }
  },
})
`;

  test("configKeys reads the options an asset chose, methods included, nested keys not", () => {
    expect(configKeys(asset)).toEqual(["description", "inputs", "key", "incremental", "checks", "columns", "rows"]);
  });

  test("contextFields reads what rows() destructures, aliases by their croft name", () => {
    expect(contextFields(asset)).toEqual(["newRows", "http", "secret", "log"]);
  });

  test("assetKind tells the four kinds apart", () => {
    expect(assetKind("assets/x.ts", asset)).toBe("transform");
    expect(assetKind("assets/x.sql", "SELECT 1")).toBe("sql");
    expect(assetKind("assets/x.ts", `ingest({\n  file: "files/*.csv",\n})`)).toBe("file-ingest");
    expect(assetKind("assets/x.ts", `ingest({\n  async *rows() {},\n})`)).toBe("rows-ingest");
  });
});

describe("hatches and notes", () => {
  const files = [
    {
      path: "lib/client.ts",
      content: [
        "// CourtListener allows 50 requests an hour, so we sleep between calls",
        "const r = await fetch(url)",
        "await Bun.sleep(1000)",
        "// fetch( in a comment is not a call",
        "const t = process.env.TOKEN",
      ].join("\n"),
    },
    { path: "bin/croft", content: "#!/bin/sh\nX=$(sops -d secrets.yaml)\nexec node_modules/.bin/croft \"$@\"" },
    { path: "assets/a.sql", content: "-- croft can't read PDFs\nSELECT * FROM x" },
  ];

  test("each workaround is found where it is written, comments excluded", () => {
    expect(findHatches(files).map((h) => `${h.file}:${h.line} ${h.kind}`)).toEqual([
      "lib/client.ts:2 fetch",
      "lib/client.ts:3 sleep",
      "lib/client.ts:5 env",
      "bin/croft:2 sops",
      "bin/croft:3 shell",
    ]);
  });

  test("comments naming croft or an API's limits are kept in the consumer's words", () => {
    expect(findNotes(files).map((n) => `${n.file}:${n.line} ${n.snippet}`)).toEqual([
      "lib/client.ts:1 CourtListener allows 50 requests an hour, so we sleep between calls",
      "assets/a.sql:1 croft can't read PDFs",
    ]);
  });

  test("commentText reads trailing comments and leaves a shebang alone", () => {
    expect(commentText("  incremental: true, // each case is fetched once")).toBe("each case is fetched once");
    expect(commentText("#!/bin/sh")).toBeNull();
  });
});

describe("package", () => {
  test("added dependencies are everything croft init did not write", () => {
    expect(addedDependencies({ dependencies: { "@zabaca/croft": "0.1.0", "pdf-parse": "1" }, devDependencies: { typescript: "5", "@types/bun": "1" } }))
      .toEqual(["pdf-parse"]);
  });

  test("lockedCroft reads the resolved version out of bun.lock", () => {
    expect(lockedCroft(`"@zabaca/croft": ["@zabaca/croft@0.1.0", "", {}]`)).toBe("0.1.0");
  });
});
