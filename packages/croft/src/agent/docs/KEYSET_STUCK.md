# KEYSET_STUCK: keyset pagination cannot move past a page of equal values

Keyset pagination asks the API for rows from the last value seen (since = the newest updated_at of the page).
When a whole page shares one value, the next request would return the same page forever. The keyset template of
croft docs ingest stops itself in that case with fail("KEYSET_STUCK", "..."), and this is that stop: the asset's
own code raised it, with its own message.

Nothing was written for the step, and its cursor did not move.

What to do: page by something that always moves forward:
- a key that strictly increases: the id (since_id, starting_after), or the timestamp together with the id when the
  API supports both;
- bigger pages (per_page: 100) so one page spans all the rows that share a value;
- the API's own cursor or Link pagination instead of a timestamp (croft docs ingest shows cursor and Link
  templates; croft new api <name> --pagination cursor writes one).
Then croft preview <asset>, and croft run <asset>. Do not remove the fail() check: without it the run would loop
until its timeout.
