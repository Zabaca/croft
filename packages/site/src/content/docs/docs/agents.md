---
title: With Claude Code and other agents
description: What croft gives an agent, where an agent finds the docs, and the one permission rule that keeps every destructive step with the person.
---

croft is built to be driven by an agent. In practice the agent writes most assets and runs most commands, and the person decides the few things only a person should: anything that destroys data, spends money or runs unattended.

## What a project gives the agent

`croft init` writes two files for Claude Code, and `croft init --claude` refreshes them after an upgrade:

- **A managed block in `CLAUDE.md`**, between markers, that says the project uses croft, names the loop, and forbids reading `.env` or touching the warehouse except through croft.
- **The skill, `.claude/skills/croft/SKILL.md`**, stamped with the project's croft version. It holds the loop, the conventions, the API pagination rules, the recipes (a failed run, a backfill, a rename, a wrong number) and the list of things to ask the user first. Because it ships with the pinned copy, it always describes the version the project runs, and `croft doctor` reports `CLAUDE_FILES_OUTDATED` when it falls behind.

`croft init --with-hook` also adds a Claude Code hook that runs `croft validate --hook` after every edit under `assets/` or `lib/`, so a broken asset is caught on the edit that broke it.

Other agents read the same files: the skill is plain Markdown, and every command below works the same from any shell.

## The loop

```sh
croft context --json     # the whole project in one payload: assets, columns, schedules, recent failures
croft validate --json    # after every edit; touches no data
croft preview <asset>    # build it in a sandbox and diff it against the live table
croft run <asset>
croft query "<select>"   # verify
```

## What every command gives back

Every command takes `--json` and prints one envelope on stdout:

```text
{schemaVersion: 1, ok, command, croftVersion, database, timezone, durationMs, data, problems[], next[],
 confirmation?}
```

- **`problems[]`** carry a stable code, a message, a hint with the literal next command or edit, and, where croft can express it, a machine-applicable `fix`: an edit (file, line, replace), a command, or a manual step marked `requiresHuman`. Every code has a page, offline with `croft docs <CODE>` and [here](/docs/reference/errors/).
- **`next[]`** lists the commands that make sense now, each with a reason. A destructive command never appears there.
- **Exit codes** separate the cases an agent must treat differently: `2` the project or command is wrong, `3` only checks failed, `4` busy, `5` a person has to decide, `6` still running. See [Exit codes](/docs/reference/exit-codes/).

The JSON Schemas for every envelope ship in the package, under `schemas/`.

Off a terminal, `croft run` follows the run for about 100 seconds, then returns exit 6 and keeps running; `croft wait <runId>` picks it up again. Nothing an agent starts is cut off by its own tool timeout.

## The person decides what destroys data

Every destructive step ends in one command: `croft confirm <token>`. A rebuild that refetches an ingest, a delete, a restore, a lossy type change and a large paid reprocessing all stop first, with exit 5 and the impact (the asset, the rows, where the trash copy goes, what downstream is affected). The token runs nothing on its own; only `croft confirm` carries it out, and it re-checks the impact before acting.

So one Claude Code permission rule gates them all:

```json
{
  "permissions": {
    "ask": ["Bash(croft confirm:*)"],
    "deny": ["Read(./.env)", "Read(./.env.*)"]
  }
}
```

The `ask` rule makes Claude Code stop before any `croft confirm`, whatever the token; the `deny` rules keep `.env` out of the agent's reach, since croft reads secrets itself and redacts every `.env` value from its output. `croft init` never writes these rules for you: [Claude Code permissions](/docs/guides/claude-permissions/) (also `croft docs claude-permissions`) explains each one. The skill tells the agent never to run `croft confirm` without the person's explicit yes in the conversation, never to read `.env`, and to ask before turning scheduling on.

## Docs for an agent that has not installed croft

An agent deciding whether to use croft, or writing code against it from outside a project, can read this site directly:

- **[`/llms.txt`](/llms.txt)** is the index of every page, written to the [llms.txt](https://llmstxt.org) convention.
- **[`/llms-full.txt`](/llms-full.txt)** is every page in one file.
- **Every docs page has a Markdown twin**: add `.md` to its path, as in [`/docs/quickstart.md`](/docs/quickstart.md). Each HTML page names its twin in a `<link rel="alternate" type="text/markdown">`.
- **A request that does not ask for HTML gets Markdown.** `curl` of a docs page returns its twin, and `curl` of the homepage returns `llms.txt`.

The Guides and Reference here are generated from croft's own `croft docs` pages at build time, so they say exactly what the CLI says, for the released version. Inside a project, prefer `croft docs`: it answers for the version that project pins, with no network.
