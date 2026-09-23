// croft help [command]: the command list, or one command's usage and options.
import { CroftError } from "../../core/errors.ts";
import { didYouMean } from "../../project/suggest.ts";
import type { Command, OptionSpec } from "../command.ts";
import { table } from "../render.ts";
import { CROFT_VERSION } from "../version.ts";

export interface OptionHelp { flag: string; short?: string; type: OptionSpec["type"]; value?: string; description: string }
export interface CommandHelp { name: string; summary: string; usage: string; options: OptionHelp[] }
export type HelpData =
  | { commands: { name: string; summary: string; usage: string }[]; globalOptions: OptionHelp[] }
  | { command: CommandHelp; globalOptions: OptionHelp[] };

/** Flags every command accepts. main.ts parses them; they are listed here for help output. */
export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", description: "print one JSON envelope on stdout (progress goes to stderr)" },
  help: { type: "boolean", short: "h", description: "show help for croft or for a command" },
  version: { type: "boolean", short: "V", description: "print the croft version" },
};

export function optionHelp(options: Record<string, OptionSpec>): OptionHelp[] {
  return Object.entries(options).map(([name, o]) => ({
    flag: `--${name}`, ...(o.short ? { short: `-${o.short}` } : {}), type: o.type,
    ...(o.value ? { value: o.value } : {}), description: o.description,
  }));
}

export function commandHelp(cmd: Command): CommandHelp {
  return { name: cmd.name, summary: cmd.summary, usage: cmd.usage, options: optionHelp(cmd.options) };
}

export const help: Command<HelpData> = {
  name: "help",
  summary: "list commands, or show one command's usage and options",
  usage: "croft help [command]",
  options: {},
  maxPositionals: 1,
  async run(ctx) {
    const globalOptions = optionHelp(GLOBAL_OPTIONS);
    const name = ctx.positionals[0];
    if (name === undefined) {
      const commands = [...ctx.commands].sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ name: c.name, summary: c.summary, usage: c.usage }));
      return { data: { commands, globalOptions }, problems: [], next: [] };
    }
    const cmd = ctx.commands.find((c) => c.name === name);
    if (!cmd) {
      const guess = didYouMean(name, ctx.commands.map((c) => c.name));
      throw new CroftError("USAGE_ERROR", {
        message: `there is no command "${name}"`,
        hint: guess ? `did you mean "croft help ${guess}"?` : "croft help lists every command",
        fix: guess
          ? { kind: "command", description: `show help for ${guess}`, command: `croft help ${guess}` }
          : { kind: "command", description: "list the commands", command: "croft help" },
      });
    }
    return { data: { command: commandHelp(cmd), globalOptions }, problems: [], next: [] };
  },
  human(result, ctx) {
    const s = ctx.render.style;
    const data = result.data;
    const optionRows = (opts: OptionHelp[]) =>
      opts.map((o) => [[o.short, `${o.flag}${o.value ? ` ${o.value}` : ""}`].filter(Boolean).join(", "), o.description]);
    const block = (rows: string[][]) => table(["", ""], rows, { limit: Infinity, maxWidth: 200, indent: "  " }).text.split("\n").slice(1).join("\n");
    if ("commands" in data) {
      return [
        `${s.bold("croft")} ${CROFT_VERSION} · local data pipelines on one DuckDB file`,
        "",
        "Usage: croft <command> [options]",
        "",
        s.bold("Commands"),
        block(data.commands.map((c) => [c.name, c.summary])),
        "",
        s.bold("Global options"),
        block(optionRows(data.globalOptions)),
        "",
        "croft help <command> shows a command's options; croft docs --list lists topics and error codes.",
      ].join("\n");
    }
    const c = data.command;
    const lines = [`${s.bold(`croft ${c.name}`)} · ${c.summary}`, "", `Usage: ${c.usage}`];
    if (c.options.length) lines.push("", s.bold("Options"), block(optionRows(c.options)));
    lines.push("", s.bold("Global options"), block(optionRows(data.globalOptions)));
    return lines.join("\n");
  },
};
