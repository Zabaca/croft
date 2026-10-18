# SECRETS_COMMAND_FAILED: croft.json's secretsFrom command did not give croft its secrets

croft.json can name a command that prints the secrets the shell and .env lack, as KEY=value lines (croft docs
secrets): "secretsFrom": {"command": ["sops", "-d", "--output-type", "dotenv", "secrets.enc.yaml"]}. croft runs it
only when an asset that runs asks for such a secret, or croft secrets checks one, at most once per croft command;
and it failed. The message says how, and ends with the end of what the command wrote to stderr, with known secrets
redacted:
- could not start: the program is not on PATH, the path does not exist, or the file is not executable;
- exited with a status, or was stopped by a signal: the store could not be opened (no key, a wrong path, no
  network);
- did not finish within 60 s: it waited for a password, a touch or a confirmation, and croft gives it no terminal
  and no input;
- printed lines, none of them KEY=value: its output is not .env text (sops needs --output-type dotenv).

Every asset step that needed one of its secrets fails with this code, and nothing is written for it; steps that
need no secret, or find theirs in the shell or .env, run. croft secrets lists those names as unchecked.

croft doctor warns with this code, without running the command, when its program is on no PATH, or only on this
shell's: scheduled runs search only Bun's folder, /opt/homebrew/bin (macOS), /usr/local/bin and the system folders,
and pass only HOME, PATH, LANG and a few more variables, so the command needs an absolute path there, and any
variable it reads must be set in the command itself (["/usr/bin/env", "SOPS_AGE_KEY_FILE=/path/to/keys.txt",
"sops", ...]).

What to do: this is the user's to fix. Never run the command yourself: what it prints is the secrets, and they
would land in the conversation.
- Ask the user to run it in their own terminal, from the project folder, to see the error in full, and to fix it
  or what it needs (install the tool, its key, the path in croft.json).
- Not found by scheduled runs: put the program's absolute path first in secretsFrom.command (the fix says it).
- A prompt: make it work unattended (sops with an age key file, a service account token), or move the secrets to
  .env.
- Then croft secrets --json shows each name as set, without its value, and croft run <asset> or croft preview
  <asset> again.
