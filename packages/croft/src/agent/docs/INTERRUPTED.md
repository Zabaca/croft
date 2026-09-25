# INTERRUPTED: the command was stopped before it finished

Ctrl-C or SIGTERM stopped a run, a preview or a prompt (exit 130). It also covers a request to croft serve whose
client went away before its query finished.

What was committed stays committed: croft writes each step in one transaction, so a step that had not committed
saved nothing and its cursor did not move. A long first load or an incremental transform keeps the parts and
chunks it had already committed, and continues from them. A preview changes nothing real.

What to do: run the same command again when you are ready; it continues from what was saved, and nothing is
fetched twice into the table. croft status shows which assets finished, and croft logs --runs the interrupted run.
Do not send SIGKILL to a run to stop it faster: croft cleans up after it, but only on the next command that
writes.
