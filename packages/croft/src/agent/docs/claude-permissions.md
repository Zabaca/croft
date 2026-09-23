# Claude Code permissions

croft init writes CLAUDE.md and .claude/skills/croft/SKILL.md, and nothing else under .claude/. It never
writes .claude/settings.json: permission rules change what Claude Code may do without asking, so they stay
your decision.

Every destructive croft action (rebuilding an ingest, --allow-shrink, delete, restore, lossy pin changes,
key conversion, large paid reprocessing) ends in one command: croft confirm <token>. So one "ask" rule makes
Claude Code stop and ask you before any of them. The "deny" rules keep your secrets out of the agent's reach.

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
