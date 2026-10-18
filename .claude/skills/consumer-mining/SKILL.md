---
name: consumer-mining
description: Mine croft's consumer projects for what croft should do next. Reads every croft project in docs/consumers/registry.json, drops the copies of our own old templates, and writes one case per croft surface (ctx.http, ingest options, secrets, the CLI, the agent texts…) — the capability a project had to build itself, the code and run history that prove it, and what it would take in packages/croft. Use when deciding what croft builds next, when consumers keep working around the same thing, or when asked what croft's users need.
user-invocable: true
---

Consumers write croft's roadmap without meaning to. Every file in a project's
`lib/` is a seam croft did not have; every `fetch(` beside `ctx.http` is a
retry, a rate limit or an auth scheme `http` could not express; every
`bin/croft` wrapper is a CLI that did not fit the place it runs; every comment
that says "croft can't" is the finding, written down by the person who hit it.
This reads that record and turns it into per-surface cases.

**The deliverable is per croft surface, not per project.** Projects are where
evidence lives; nobody acts on "here is what ceo-seo does". They act on "here
is what `ctx.http` is missing, from two projects that each paced CourtListener
and DataForSEO by hand".

The method comes from zbc's skill of the same name
(`~/Projects/zabaca/zbc/.claude/skills/consumer-mining/`). What is different
here: croft vendors *text* rather than modules, consumers lag by whole
releases, and every local checkout carries its own run history.

## The mistakes this exists to prevent

**Reading our own history back to us as feedback.** `croft init` writes
`.claude/skills/croft/SKILL.md`, the CLAUDE.md block and the example asset
into every project. A project on 0.1.0 differs from `main` in all of them
without anyone having touched a line. So the collector hashes each vendored
file against **every git revision** of its template
(`packages/croft/src/agent/skill.md`, `claude-md.md`, `claude-md-app.md`,
`project/assets/example_sales.ts`), first restoring the skill's version stamp
to `{{version}}`, then again after a normalisation pass that strips quote
style, trailing punctuation, indentation and blank lines. A match at any
revision is `current` or `stale` and teaches nothing. Never diff a consumer's
skill against `main` by hand.

**Reporting a gap 0.2 already closed.** Both registered projects pin 0.1.0.
Their workaround is real, but their reason may be one release old. Before
calling anything missing, check `main`:

```bash
git log --oneline croft-v<pinned>..main -- packages/croft/src     # what shipped since they pinned
grep -rn "<the thing>" packages/croft/src/agent/docs DESIGN.md     # whether croft documents it now
```

The verdict says their code differs. Only `main` says whether croft still
lacks the capability. A gap closed since then is still worth a line, but in
the *distribution* case: the fix exists and they don't have it.

**Mistaking a project's own business for croft's.** leave-guide's `lib/law.ts`
reads YAML specs from `../law`. That could be a missing file-ingest format or
just how that project is organised. The evidence decides: does an asset turn
that data into rows, and would a `file:` ingest have done it?

## Run it

```bash
bun scripts/consumer-survey.ts                  # every project in the registry
bun scripts/consumer-survey.ts leave-guide      # or named ones, while iterating
bun test scripts/                               # the collector's own tests
```

Writes to `.consumer-survey/`, which is **gitignored as a whole**. croft is a
public repository and its consumers are private; the survey quotes their
code, their clients' names and their error messages. Nothing under it gets
committed, cases included. Only the registry is checked in.

- `<id>.json` per project: `croft` (pinned, locked, current), `vendored` (a
  verdict per template), `assets` (kind, `configKeys`, `contextFields`,
  imports, and `runs` by status when there is state), `ownCode` (everything
  outside `assets/` and the scaffold), `hatches`, `notes`, `outsideRefs`
  (files elsewhere in the repo that drive croft or name the project),
  `commits`, `runHistory`.
- `index.json`: the same regrouped by surface (`hatch:fetch`,
  `failure:HTTP_ERROR`, `dependency:<name>`, `own-code`, `vendored:<name>`),
  plus `usage` (which options and context fields projects actually use) and
  `drift`.

| Vendored verdict | Meaning | Worth a case? |
|---|---|---|
| `current` | our newest template, verbatim | no |
| `stale` | an older template, verbatim | no, but `croft init --claude` refreshes it; record it under distribution |
| `divergent` | our text, edited | **yes**: an edit to our agent text is a correction to our docs |
| `removed` | deleted | only when it's the skill or the block. Deleting the example asset is the expected path |

And what has no template:

| Finding | Where | What it can mean |
|---|---|---|
| `ownCode` | `lib/`, `bin/`, `scripts/`, the project's own `.claude/` | a seam croft lacks (shared code, a wrapper, a skill of their own about croft) |
| `hatches` | assets and own code, comments excluded | `fetch`, `sleep`, `shell`, `duckdb`, `sops`, `env`, `fs`, `scheduler`, `croft-state`, `fail` |
| `notes` | comments naming croft, a workaround or an API limit | the consumer's own account. Read these first |
| `addedDependencies` | beyond `@zabaca/croft`, `@types/bun`, `typescript` | a format croft cannot read, a client it does not offer |
| `runHistory` | `.croft/runs.sqlite` of the `state` checkout | failures by asset and code, retries, confirmations, schedules |
| `outsideRefs` | the rest of the repo | how the data is consumed (`@zabaca/croft/read` or something else), and wrappers or skills built around the CLI |

`runHistory` is croft's equivalent of zbc's "deployed in production". An asset
that has run forty times and failed the same way six of them is evidence. An
asset that never ran is opinion. It exists only where `state` points at a
checkout on this machine, since `.croft/` is never committed.

## Fan out, one agent per project

Only for projects that have material: own code, hatches, notes, failures, a
divergent or removed vendored file. Give each agent its own
`.consumer-survey/<id>.json` and this brief:

> Read `.consumer-survey/<id>.json`. The project is at
> `.consumer-survey/repos/<id>/<root>` (its run state, read-only, at the
> `stateFrom` path). For every own-code file, hatch, note and failure, report
> what capability the project needed and what evidence proves it. Read the
> code around each hit, not just the line. Do not propose croft changes and
> do not compare against other projects; you cannot see them. Report only
> what this project shows. Never open warehouse*.duckdb or .env.

For a `divergent` vendored file, diff against the revision it came from:

```bash
git show <nearestRev>:packages/croft/src/agent/skill.md \
  | sed "s/{{version}}/<stamp>/" > "$TMPDIR/base.md"
diff "$TMPDIR/base.md" .consumer-survey/repos/<id>/<root>/.claude/skills/croft/SKILL.md
```

Fixed report schema per finding, so the synthesis step can merge them:

- **capability**: one line, what the project needed that croft did not give it
- **surface**: which part of croft it lands on (`http`, `ingest`,
  `file-ingest`, `transform`, `checks`, `schedule`, `secrets`, `read`, `cli`,
  `agent-texts`, `project-layout`, `types`)
- **evidence**: file:line in their project, the config keys involved, and the
  failure rows (asset, code, count) if any
- **why croft fell short**: from the code and the run history, not from
  guessing. Then checked against `main` (see above): `still missing`,
  `fixed since <pin>`, or `croft has it, the project didn't know`. The last
  one is an agent-texts or docs finding, not a feature
- **exercised?**: runs and failures from `runHistory`, or "no state"

## Synthesise per surface

One pass over all the reports, grouped by surface. This is the only step that
can see across projects:

- where independent projects **agree**, that's the shape of the feature
- where they **disagree**, that's its options
- where only one project went, it's either a real edge case or that project's
  quirk. Saying which is the judgment this whole exercise is buying

Start from `index.json`'s `usage` table. It shows which options and context
fields projects actually reach for, and a croft option nobody uses is a
finding too.

Weight the evidence:

1. **exercised**: an asset with real runs and failures beats one that has
   never run.
2. **independence**: two projects that hit the same API limit separately
   beat one project hitting it twice.
3. **still missing on main**: a gap closed since the pin goes to the
   distribution case, not to a feature case.
4. **count**: a ranking signal, never a gate. With two consumers, one solid
   case is normal.

## Write the cases

One file per surface at `.consumer-survey/cases/<surface>.md`, overwritten
each run:

```markdown
# <surface> — <new | upgrade | docs | distribution>

**Projects:** <ids>  ·  **Exercised in:** <ids, with run and failure counts>

## What they needed
<the capability, one paragraph>

## How each project did it
<per project: the workaround, file:line, and what it costs them>

## Still missing on main?
<the grep and git log that settled it>

## What it takes in croft
<the concrete change in packages/croft/src, and the DESIGN.md section it touches>
```

Then `.consumer-survey/cases/README.md`: every case, one line each, ordered
by the weighting above, with `new`, `upgrade`, `docs` and `distribution` split
apart.

When the user wants a case to live past the run, say as a GitHub issue,
**rewrite it without the consumer's private details**: no client names, no
quoted private code, no error messages carrying URLs or queries. Show them
the rewrite before anything leaves this machine. croft is public.

## Where this stops

It produces cases, not commits. Deciding which to build, and whether a
capability belongs in croft at all, is a human call. Make it against
DESIGN.md's thesis and decision log: croft is one tool on one machine with one
DuckDB file, and a case arguing for a server or a warehouse argues against
the design. A case that argues its own promotion has overstepped. It should
make the need clear enough that the call is easy.

Registry maintenance is manual. A new project means a new entry in
`docs/consumers/registry.json`. The collector will not discover one on its
own, by design: `access`, `root`, `state` and `tier` are facts no script can
derive. To find unregistered projects, look for `croft.json` under
`~/Projects` and on ryzen-9, skipping `node_modules` and worktrees (where
`.git` is a file). For a `local:` project, commit first: it is read from
`HEAD`.
