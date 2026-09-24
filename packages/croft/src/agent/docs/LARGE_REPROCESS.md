# LARGE_REPROCESS: a transform that pays per row would process many rows; a person decides

An incremental TypeScript transform that makes requests (ctx.http, fetch(), or an HTTP or LLM SDK, also through
lib/) and would process more than its confirmAbove input rows in one run (default 1000) stops before any of its
code runs. It happens on a first build of a large input, and when an upstream rewrote many rows. croft never
spends the user's API money on a large batch implicitly. details.pending and details.inputs give the row
counts.

How the run asks:
- On a terminal, it prints the impact and asks Proceed? [y/N].
- Off a terminal, as in Claude Code, the run exits 5 with confirmation: {token, command, impact}, and nothing is
  processed. Show the user the impact (how many input rows, each making requests) and wait for their explicit
  yes in this conversation; then croft confirm <token>. A token lasts 15 minutes.
- croft run --dry-run shows the same confirmation, with an estimate, and asks nothing.

Other ways forward:
- Try the code on a few rows first: croft preview <asset> --rows 20 (nothing real changes).
- If the user wants runs this size to go ahead without asking, raise confirmAbove in the asset, with their yes.
- A transform that should make no requests at all: remove them, and the guard no longer applies.
