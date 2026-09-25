# ENV_FILE_IGNORED: a .env.* file whose values croft does not read (warning)

croft reads secrets from the project's .env, and from the shell environment, which wins over it. Other .env files
(.env.local, .env.production, ...) are ignored on purpose: Bun's own .env loading, which would read them and let
.env.local override .env silently, is off (croft docs secrets). croft doctor and croft secrets warn once per
ignored file, so a value put there by habit is not mistaken for a set secret. .env.example, .env.sample and
.env.template are templates and are not reported.

Nothing is blocked; secrets that live only in the ignored file count as missing.

What to do: ask the user to move the values croft needs from that file into .env (in their editor; never read
either file yourself), and to delete the ignored file if nothing else uses it. croft secrets --json then shows
which declared secrets are set.
