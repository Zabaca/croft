# ENV_FILE_INVALID: a line of .env that croft cannot parse (warning)

croft reads .env itself, with the usual syntax: KEY=value per line, # comments, an optional export prefix, 'single'
and `backtick` quotes taken literally, "double" quotes with \n \t \" \\ escapes, quoted values over several lines
(croft docs secrets). A line that does not fit (a missing =, an unterminated quote, a key with spaces) is skipped,
and croft doctor and croft secrets report it with its line number.

The other lines are read. A secret on the skipped line counts as missing.

What to do: ask the user to fix that line of .env in their editor. Never read .env yourself: the line number is
enough. croft doctor and croft secrets --json then show whether it parses and which secrets are set.
