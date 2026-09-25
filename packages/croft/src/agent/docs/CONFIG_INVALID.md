# CONFIG_INVALID: croft.json, or one of croft's own settings files, is not valid

croft.json holds the project's settings and is read without running any code. CONFIG_INVALID lists every issue
it has, each with its line: JSON that does not parse, an unknown key (with a did-you-mean), a value of the wrong
type or out of range, a time zone DuckDB does not know, a path that cannot be used. croft docs config lists every
key, its type and its default.

It also covers the scheduler's per-user files under ~/.croft: projects.json (the projects the scheduler serves) or
its lock file, when they are damaged.

Nothing ran.

What to do:
- croft.json: fix each issue the message lists (the fix, when there is one, is the edit), then run
  croft validate --json or croft doctor. Keep "timezone" a canonical IANA name such as America/Los_Angeles.
- Moving "database" or "stateDir" moves where croft looks for the warehouse and its state; the files do not move
  with them. Ask the user before changing either.
- ~/.croft/projects.json or its lock: follow the hint (with no croft schedule command running, delete the file,
  then croft schedule on again in each project that should run on a schedule). Ask the user first: it affects
  every project on this machine.
