// Writes the site's Guides and Reference pages from croft itself, before every dev and build.
//
// What `croft docs <topic|CODE>` prints and what this site says must not be two documents: one would stop being
// true. So nothing under src/content/docs/docs/guides or src/content/docs/docs/reference is written by hand, and
// both folders are git-ignored. Each page is the CLI's own page for that topic or code, read through the same
// command the CLI runs, with three changes so it reads as Markdown on the web:
//   - aligned text tables and indented examples become code blocks (the CLI prints them for a terminal);
//   - `<asset>`-style placeholders are escaped, so they stay text rather than becoming HTML tags;
//   - `croft docs X` becomes a link to the page for X.
// The CLI reference comes from the same command registry `croft help` reads.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, docs, EXIT_MEANINGS, type DocsData } from "../../croft/src/cli/commands/docs.ts";
import { COMMANDS } from "../../croft/src/cli/commands/index.ts";
import { GLOBAL_OPTIONS, optionHelp, type OptionHelp } from "../../croft/src/cli/commands/help.ts";
import type { Ctx } from "../../croft/src/cli/command.ts";
import { CROFT_VERSION } from "../../croft/src/cli/version.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "src/content/docs/docs");
const SOURCE = "https://github.com/Zabaca/croft/edit/main/packages/croft/src/agent/docs";

/** The topics shown as guides, in sidebar order, with a short sidebar label. The rest are reference. */
export const GUIDES: [topic: string, label: string][] = [
  ["ingest", "Ingests: APIs and files"],
  ["sql", "SQL transforms"],
  ["transforms", "TypeScript transforms"],
  ["checks", "Checks"],
  ["scheduling", "Scheduling"],
  ["secrets", "Secrets"],
  ["serve", "Apps and croft serve"],
  ["read-copy", "GUIs and notebooks"],
  ["rename", "Renaming an asset"],
  ["trash", "The trash"],
  ["claude-permissions", "Claude Code permissions"],
];

/** Built-in reference topics, after the CLI page. */
export const REFERENCE: [topic: string, label: string][] = [
  ["config", "croft.json"],
  ["json", "The --json envelope"],
  ["errors", "Problems and error codes"],
  ["exit-codes", "Exit codes"],
  ["internals", "Internals"],
];

/** Where `croft docs <name>` lives on this site. */
export function hrefFor(name: string, codes: Set<string>): string | undefined {
  if (codes.has(name.toUpperCase())) return `/docs/reference/errors/${name.toLowerCase().replaceAll("_", "-")}/`;
  const n = name.toLowerCase();
  if (GUIDES.some(([t]) => t === n)) return `/docs/guides/${n}/`;
  if (REFERENCE.some(([t]) => t === n)) return `/docs/reference/${n}/`;
  return undefined;
}

async function page(name: string): Promise<DocsData> {
  return (await docs.run({ positionals: [name], values: {} } as unknown as Ctx)).data;
}

/** A text table or example: two or more columns aligned with runs of spaces. */
const aligned = (line: string) => /\S {3,}\S/.test(line.trimStart());
const isListItem = (line: string) => /^(\s*)([-*]|\d+\.) /.test(line);

/**
 * The CLI's Markdown, made safe for the web. Fenced blocks pass through. Outside them, a run of aligned lines, or an
 * indented block that does not continue a list item, becomes a ```text block; prose gets its placeholders escaped
 * and its `croft docs X` mentions linked.
 */
export function toWebMarkdown(src: string, codes: Set<string>): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inList = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const end = lines.findIndex((l, j) => j > i && l.startsWith("```"));
      const stop = end === -1 ? lines.length : end + 1;
      out.push(...lines.slice(i, stop));
      i = stop;
      inList = false;
      continue;
    }
    if (line.trim() === "") {
      out.push(line);
      inList = false;
      i++;
      continue;
    }
    const indented = /^ {2,}\S/.test(line);
    const startsBlock = (indented && !inList) || (aligned(line) && !isListItem(line) && (aligned(lines[i + 1] ?? "") || indented));
    if (startsBlock) {
      const block: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && (/^ {2,}\S/.test(lines[i]!) || aligned(lines[i]!)) && !isListItem(lines[i]!)) {
        block.push(lines[i]!);
        i++;
      }
      const pad = Math.min(...block.map((l) => l.match(/^ */)![0].length));
      if (out.length && out.at(-1)!.trim() !== "") out.push("");
      out.push("```text", ...block.map((l) => l.slice(pad)), "```", "");
      inList = false;
      continue;
    }
    // "name: what it means" lines, one per line in the terminal, would run together as one paragraph.
    const labelled = /^[a-z][\w.-]*: \S/;
    if (labelled.test(line) && (labelled.test(lines[i + 1] ?? "") || labelled.test(lines[i - 1] ?? ""))) {
      const [, label, rest] = line.match(/^([a-z][\w.-]*): (.*)$/)!;
      out.push(`- **${label}**: ${inline(rest!, codes)}`);
      inList = true;
      i++;
      continue;
    }
    if (isListItem(line)) inList = true;
    out.push(inline(line, codes));
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** One line of prose: code spans are kept, the text between them escaped and linked. */
function inline(line: string, codes: Set<string>): string {
  return line.split(/(`[^`]*`)/).map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      const m = part.slice(1, -1).match(/^croft docs ([A-Za-z_-]+)$/);
      const href = m && hrefFor(m[1]!, codes);
      return href ? `[${part}](${href})` : part;
    }
    let text = part
      .replace(/</g, "&lt;")
      .replace(/(^|[\s(])_(?=\w)/g, "$1\\_")
      .replace(/(?<!^\s*)\*/g, "\\*");
    text = text.replace(/croft docs ([A-Za-z_-]+[A-Za-z])/g, (all, name: string) => {
      const href = hrefFor(name, codes);
      return href ? `[\`${all}\`](${href})` : all;
    });
    return text;
  }).join("");
}

/** The first heading split into a title and the rest ("# CODE: what it means" → CODE, what it means). */
function heading(md: string): { title: string; rest: string; body: string } {
  const lines = md.split("\n");
  const first = lines.findIndex((l) => l.startsWith("# "));
  const h = first === -1 ? "" : lines[first]!.slice(2).trim();
  const body = first === -1 ? md : lines.slice(first + 1).join("\n");
  const colon = h.indexOf(": ");
  return colon === -1 ? { title: h, rest: "", body } : { title: h.slice(0, colon), rest: h.slice(colon + 2), body };
}

const yaml = (s: string) => JSON.stringify(s);

function frontmatter(fields: Record<string, string | number | false | Record<string, string | number>>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "object" && v !== null) {
      lines.push(`${k}:`);
      for (const [kk, vv] of Object.entries(v)) lines.push(`  ${kk}: ${typeof vv === "string" ? yaml(vv) : vv}`);
    } else lines.push(`${k}: ${typeof v === "string" ? yaml(v) : v}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function optionTable(options: OptionHelp[]): string {
  if (options.length === 0) return "";
  const rows = options.map((o) => {
    const flag = `${o.short ? `${o.short}, ` : ""}${o.flag}${o.value ? ` ${o.value}` : ""}`;
    return `| \`${flag}\` | ${o.description.replace(/</g, "&lt;").replace(/\|/g, "\\|")} |`;
  });
  return ["| Option | What it does |", "|---|---|", ...rows].join("\n");
}

export async function generate(): Promise<{ pages: number }> {
  const list = (await docs.run({ positionals: [], values: { list: true } } as unknown as Ctx)).data as Extract<DocsData, { topics: unknown }>;
  const codes = new Set(list.codes.map((c) => c.code));
  let pages = 0;

  for (const dir of ["guides", "reference"]) rmSync(join(OUT, dir), { recursive: true, force: true });
  mkdirSync(join(OUT, "guides"), { recursive: true });
  mkdirSync(join(OUT, "reference/errors"), { recursive: true });

  const write = (rel: string, text: string) => {
    writeFileSync(join(OUT, rel), text);
    pages++;
  };

  // Guides: the topic pages, in the order a new project meets them.
  for (const [i, [topic, label]] of GUIDES.entries()) {
    const d = (await page(topic)) as Extract<DocsData, { topic: string }>;
    const h = heading(d.page);
    write(`guides/${topic}.md`, frontmatter({
      title: h.rest ? `${h.title}: ${h.rest}` : h.title,
      description: `croft docs ${topic}: ${h.rest || h.title}`,
      sidebar: { label, order: i },
      editUrl: d.source === "file" ? `${SOURCE}/${topic}.md` : false,
    }) + toWebMarkdown(h.body, codes) + `\nThe same page is in the CLI: \`croft docs ${topic}\`.\n`);
  }

  // Reference: every command, from the registry `croft help` reads.
  const commands = COMMANDS.filter((c) => !c.hidden).sort((a, b) => a.name.localeCompare(b.name));
  const cli = [
    frontmatter({
      title: "Commands",
      description: `Every croft ${CROFT_VERSION} command, its usage and its options, as croft help prints them.`,
      sidebar: { label: "Commands", order: 0 },
      editUrl: false,
    }),
    `croft ${CROFT_VERSION} has ${commands.length} commands. \`croft help <command>\` prints the same usage and options in the terminal.`,
    "",
    "## Every command takes",
    "",
    optionTable(optionHelp(GLOBAL_OPTIONS)),
    "",
    ...commands.flatMap((c) => [
      `## ${c.name}`,
      "",
      capitalize(c.summary.replace(/</g, "&lt;")) + ".",
      "",
      "```sh",
      c.usage,
      "```",
      "",
      optionTable(optionHelp(c.options)),
      "",
    ]),
  ].join("\n");
  write("reference/cli.md", cli);

  for (const [i, [topic, label]] of REFERENCE.entries()) {
    const d = (await page(topic)) as Extract<DocsData, { topic: string }>;
    const h = heading(d.page);
    write(`reference/${topic}.md`, frontmatter({
      title: h.rest ? `${h.title}: ${h.rest}` : h.title,
      description: `croft docs ${topic}`,
      sidebar: { label, order: i + 1 },
      editUrl: d.source === "file" ? `${SOURCE}/${topic}.md` : false,
    }) + toWebMarkdown(h.body, codes) + (topic === "errors" ? codeIndex(list.codes) : "") +
      `\nThe same page is in the CLI: \`croft docs ${topic}\`.\n`);
  }

  // One page per error code, written or generated, the way `croft docs CODE` answers.
  for (const c of list.codes) {
    const d = (await page(c.code)) as Extract<DocsData, { code: string }>;
    const h = heading(d.page);
    const slug = c.code.toLowerCase().replaceAll("_", "-");
    const facts = `**${capitalize(d.severity)}** · category **${d.category}** (${CATEGORIES[d.category].meaning}) · exit **${d.exit}** (${EXIT_MEANINGS[d.exit] ?? ""})`;
    write(`reference/errors/${slug}.md`, frontmatter({
      title: c.code,
      description: h.rest || `${c.code}: ${CATEGORIES[d.category].meaning}`,
      sidebar: { label: c.code },
      editUrl: d.source === "file" ? `${SOURCE}/${c.code}.md` : false,
    }) + `${facts}\n\n${h.rest ? `${capitalize(h.rest)}.\n\n` : ""}` + toWebMarkdown(h.body, codes) +
      `\nThe same page is in the CLI: \`croft docs ${c.code}\`.\n`);
  }

  writeFileSync(join(ROOT, "src/generated-version.json"), JSON.stringify({ version: CROFT_VERSION, commands: commands.length, codes: codes.size }) + "\n");
  return { pages };

  function codeIndex(all: { code: string; category: string; severity: string; exit: number }[]): string {
    const rows = [...all].sort((a, b) => a.code.localeCompare(b.code)).map((c) =>
      `| [${c.code}](${hrefFor(c.code, codes)}) | ${c.category} | ${c.severity} | ${c.exit} |`);
    return ["", "## Every code", "", "| Code | Category | Severity | Exit |", "|---|---|---|---|", ...rows, ""].join("\n");
  }
}

if (import.meta.main) {
  const { pages } = await generate();
  console.log(`reference: ${pages} pages from croft ${CROFT_VERSION}`);
}
