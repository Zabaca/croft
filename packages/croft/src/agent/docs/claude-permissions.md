# Claude Code permissions

croft init writes CLAUDE.md and .claude/skills/croft/SKILL.md, and nothing else under .claude/. It never
writes .claude/settings.json: permission rules change what Claude Code may do without asking, so they stay
your decision.

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
