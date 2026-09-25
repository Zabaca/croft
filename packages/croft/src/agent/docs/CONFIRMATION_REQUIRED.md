# CONFIRMATION_REQUIRED: this action changes or removes data, and waits for a person's yes

croft never destroys or rewrites data on its own. A command that would do so stops before changing anything,
prints the impact and a token, and exits 5:
- croft delete (a table, or rows --where), croft restore (it overwrites the current table);
- croft run --allow-shrink, croft run --rebuild of an ingest or an incremental transform;
- a run that would reprocess many paid input rows (LARGE_REPROCESS), convert an ingest to a key, or apply a pin
  that changes stored values (INGEST_CONFIG_CHANGED, PIN_CHANGES_DATA).

The envelope's confirmation holds token, expiresAt (15 minutes), command (what will be carried out) and impact
(asset, action, rows, bytes, the trash path, downstream assets, estimated requests). Nothing was changed. Off a
terminal, where Claude Code runs croft, it always ends here.

What to do:
1. Show the user the impact in plain words: what is removed or redone, how many rows, what it may cost, and that
   the old data goes to the trash first (croft restore brings it back).
2. Ask the user, and wait for an explicit yes in this conversation. Silence, "ok, fix it" earlier, or a yes to
   something else is not a yes to this.
3. Only then: croft confirm <token>. It recomputes the impact; if it changed, you get CONFIRMATION_STALE.
If the user says no, do nothing and say what stays as it is. Never put croft confirm in a script or a loop.
