# INGEST_CONFIG_CHANGED: an ingest's key, write mode or incremental field changed while it has data

An ingest's key, write ("replace", "append" or "merge") and incremental field decide how its stored rows were
written. When the code changes one of them while the table has rows, croft run stops before fetching anything:
the stored rows were written under the old rules, and croft never rewrites them on its own. The message says what
changed (write: append → merge; key: none → id; incremental: updated_at → created_at); details.from and details.to
give both sides, details.rows the rows stored, and details.fixes every way forward.

Not a change: a reordered or re-cased key, adding a lookback (it applies directly), and any change while the table
is empty or was never built.

Ask the user which way to go:
- Put the setting back as it was (the problem's fix points at the file). Nothing else changes.
- croft run <asset> --rebuild refetches everything under the new rules. The current table goes to the trash first
  (croft restore brings it back), and it asks for a confirmation, because the source may no longer have the old
  history. Run it only after the user agrees.
- A key added to an append ingest (an event log that gains an id) can convert in place instead. croft run <asset>
  itself asks: on a terminal Proceed? [y/N], elsewhere exit 5 with a token and the impact (impact.rows: the
  duplicate rows that would go). After the user's explicit yes, croft confirm <token> moves the table to the trash
  first, keeps the latest row of each key (the latest _loaded_at, then the highest cursor), then fetches as usual.
  With no duplicate stored, the key applies at once, with no question and nothing trashed. Stored rows without the
  key (NULL, or no such column) rule the conversion out: details.convertible is false.

The scheduler holds an edited ingest until it is run by hand, so the question always reaches a person; a run that
cannot ask fails with this problem and changes nothing. croft preview <asset> converts its own copy without asking,
so the preview shows what a conversion keeps.
