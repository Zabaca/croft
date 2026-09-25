# Claude Code permissions

croft init writes CLAUDE.md and .claude/skills/croft/SKILL.md, and nothing else under .claude/. It writes
.claude/settings.json only when you ask for the validate hook (croft init --claude --with-hook, below):
permission rules and hooks change what Claude Code may do without asking, so they stay your decision.

Every destructive croft action ends in one command, croft confirm <token>:
- croft run --rebuild of an ingest or of an incremental transform;
- --allow-shrink (a replace ingest about to write far fewer rows than it has);
- croft delete and croft restore;
- a lossy pin change or a key conversion of an ingest;
- large paid reprocessing (an incremental transform that would make requests for more rows than its
  confirmAbove, LARGE_REPROCESS).
Those that replace or remove data move it to the trash first. So one "ask" rule makes Claude Code stop and ask
you before any of them. The "deny" rules keep your secrets out of the agent's reach.

Suggested rules, for .claude/settings.json (shared with your team) or .claude/settings.local.json (just you):

  {
    "permissions": {
      "ask": ["Bash(croft confirm:*)"],
      "deny": ["Read(./.env)", "Read(./.env.*)"]
    }
  }

If the croft project lives in data/ inside an app, use "Read(./data/.env)" and "Read(./data/.env.*)" in the
app's settings as well.

What the rules do:
- "ask": ["Bash(croft confirm:*)"]: Claude Code asks you before it runs croft confirm, whatever the token.
  The croft skill already tells the agent to wait for your explicit yes; this rule enforces it.
- "deny": ["Read(./.env)", ...]: Claude Code cannot open .env. croft reads secrets itself and redacts every
  .env value from its output, so the agent never needs the values.

Add the rules by hand, or ask Claude Code to add them after you have read them. Run croft docs secrets for how
croft handles .env.

## The validate hook (opt-in)

croft init --claude --with-hook (or croft init --with-hook for a new project) adds a PostToolUse hook to
.claude/settings.json. After every Edit, Write or MultiEdit, Claude Code runs croft validate --hook, which
checks the edit at once, so a broken asset is caught before the next step rather than at croft run:

  {
    "hooks": {
      "PostToolUse": [
        {
          "matcher": "Edit|Write|MultiEdit",
          "hooks": [
            {
              "type": "command",
              "command": "cd \"$CLAUDE_PROJECT_DIR\" && test -x ./node_modules/.bin/croft || exit 0; ./node_modules/.bin/croft validate --hook",
              "timeout": 120
            }
          ]
        }
      ]
    }
  }

What croft validate --hook does:
- It reads the edited file from the JSON Claude Code sends on stdin (tool_input.file_path). Claude Code
  writes it and closes stdin at once; stdin still open after 5 seconds is a usage error.
- An edit that is not an asset in assets/ or a file in lib/ checks nothing: exit code 0, no output.
- Otherwise it validates that asset, plus the assets that read it when it is SQL (a renamed column breaks
  them), or, for a file in lib/, the TS assets that import it. It never opens the warehouse or the network.
- With an error, it prints the problems on stderr and exits with exit code 2, which Claude Code shows to
  Claude after the edit (the edit itself is already made). Warnings and a clean check print nothing.
- Exit code 2 is only for problems in the edited assets. When croft itself cannot check the edit (bun is
  not on the PATH Claude Code gives its hooks, Bun is too old, the DuckDB binding does not load, stdin is
  not the hook's JSON), it exits with exit code 1: Claude Code shows you a non-blocking "hook error" notice
  with the first line of the problem, and Claude carries on.

The command,

  cd "$CLAUDE_PROJECT_DIR" && test -x ./node_modules/.bin/croft || exit 0; ./node_modules/.bin/croft validate --hook

runs the project's own croft (node_modules/.bin/croft, from bun install) from the folder Claude Code
started in ($CLAUDE_PROJECT_DIR), wherever Claude has moved since. For a project in data/ inside an app,
the app's settings say cd "$CLAUDE_PROJECT_DIR"/data instead, and data/.claude/settings.json gets the plain
form for sessions started in data/. croft merges the hook into settings you already have and keeps
everything else in them; running it again adds nothing twice. Until bun install has run (a fresh clone, a
teammate who pulled the settings, an app whose data/ is not installed yet), test -x finds no pinned croft
and the hook does nothing.

Claude Code started from the Dock, Finder or an IDE may not have Bun's folder (~/.bun/bin) on its PATH. Then
each edit shows the notice "croft validate --hook did not run: bun is not on the PATH Claude Code gives its
hooks". Start Claude Code from a terminal where bun works, or add ~/.bun/bin to the PATH it starts with.

To remove the hook, delete its entry from hooks.PostToolUse in .claude/settings.json.
