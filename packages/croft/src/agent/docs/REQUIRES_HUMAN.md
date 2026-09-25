# REQUIRES_HUMAN: this step is for a person, not an agent

Some steps need a person on purpose. croft secrets set NAME reads a secret from a hidden prompt at a terminal, so
the value never passes through a command line, a log or a conversation. Run off a terminal (as Claude Code runs
commands) and without --stdin, it cannot prompt, so it exits 5 and changes nothing.

.env was not changed.

What to do: ask the user to do it themselves, either way:
- open .env in their editor and add NAME=... on a line of its own; or
- run croft secrets set NAME in their own terminal.
Never ask the user to paste the secret into the conversation, and never read .env. Afterwards croft secrets --json
shows the name as set (without its value); then run what needed it.
