# SECRET_MISSING: a secret an asset needs is not set, or not declared

An asset lists the secrets it reads (secrets: ["STRIPE_KEY"]) and reads them with ctx.secret("STRIPE_KEY"). croft
takes the values from the project's .env, or from the shell environment, which wins over .env (croft docs secrets).
SECRET_MISSING means one of two things:
- the name is declared, but no value is set: croft validate and croft doctor warn; a run of the asset fails when
  its code asks for the value, and nothing is written for it;
- the code called ctx.secret("NAME") for a name its secrets list does not declare: only declared names can be read.

What to do:
- Not set: ask the user to add NAME=... to .env in their editor, or to run croft secrets set NAME in their own
  terminal (a hidden prompt). Never read .env, and never ask the user to paste a secret into the conversation.
  croft secrets --json then shows it as set, without its value.
- Not declared: add the name to the asset's secrets list (the fix says where), then croft validate --json.
- Then run the asset again: croft preview <asset>, or croft run <asset>.
