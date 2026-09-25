# BUN_TOO_OLD: this Bun is older than croft needs

croft runs on Bun and needs Bun 1.3.14 or newer: it relies on Bun behavior that older versions lack. The message
names both versions. Every command refuses to run on an older Bun, and croft doctor reports it as an error.

Nothing ran.

What to do: upgrading Bun changes the user's machine, so ask the user to run bun upgrade (or to install a newer Bun
the way they installed it), then croft doctor to check. A project pins its croft version in package.json, not its
Bun; every project on the machine uses the same Bun.
