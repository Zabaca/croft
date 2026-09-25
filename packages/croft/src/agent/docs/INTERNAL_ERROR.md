# INTERNAL_ERROR: a bug in croft, not in the project

croft hit a state its code does not expect. The message is the underlying error and details.stack the trimmed
stack (croft's own frames). It is not caused by the asset code, the data or the command line: those have codes of
their own. The scheduler also reports it when it could not start a run it planned; the assets then stay due and it
tries again after a wait.

What croft had committed before the error stays committed; the step that failed wrote nothing.

What to do:
- Report it: the command you ran, and its full --json output (the stack included). Secrets are already redacted.
- Run croft doctor: an install problem (Bun, the DuckDB binding, a broken node_modules) can surface this way, and
  doctor names the fix.
- Running the same command again can succeed when the cause was transient; do it once, not in a loop. If it fails
  the same way, stop and tell the user.
