# CLAUDE_FILES_OUTDATED: the project's Claude Code files are older than this croft (warning)

croft init writes the croft block of CLAUDE.md and .claude/skills/croft/SKILL.md: what Claude Code knows about
this croft's commands. croft doctor compares them with the installed croft and warns when they differ: croft was
upgraded, the block was edited by hand, or a file is missing. details.reasons lists what differs.

Nothing is blocked. But an out-of-date SKILL.md can send the agent to commands or flags this croft names
differently, or miss ones it has.

What to do: croft init --claude. It rewrites only the croft block of CLAUDE.md (the rest of the file stays as it
is) and SKILL.md, and touches nothing else in the project. Then croft doctor to check. A hand edit inside the croft
block is lost, so keep project notes outside it.
