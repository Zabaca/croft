# LAKE_CONNECTION_LOST: croft lost its connection to the lake and could not get it back

croft talks to a lake's catalog (a Postgres) and its bucket for as long as a command runs. A dropped connection comes
back by itself when the next statement runs, so croft tries a read again, and a whole write step again, a few times
with a pause. This is what is left when that did not help: the catalog or the store stayed unreachable, or went away
again at once. details.database names the lake; the message holds DuckDB's first line, with every password and key
taken out.

The lake is consistent. A write step either committed completely or not at all: if a commit may have landed when the
connection dropped, croft checked for it by a tag the commit carries before it ran the step again, and it never runs a
step again after its commit landed. If that check could not be made either, the code is LAKE_COMMIT_UNCERTAIN.

What to do:
- Check that the Postgres and the bucket are up and reachable from this machine (a restart, a network change or a
  firewall are the usual causes), then run the command again. `croft status` shows what the last run wrote.
- This is not fixed by changing settings or secrets. If the login or key were wrong, the lake would not have attached
  at all (LAKE_ATTACH_FAILED).
