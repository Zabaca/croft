# QUERY_TOO_MANY_ROWS: a query for an app returned more than it may, and croft never returns part of it

An app queries through @zabaca/croft/read, directly or over croft serve. A result has limits: the { limit } the
call passed (10,000 rows by default), and on the server serve.maxRows (100,000) and serve.maxBytes (64 MiB).
When the result goes past one of them, croft fails the query rather than hand back a silently cut result, which an
app would show as if it were complete. details.limit, details.maxRows or details.maxBytes say which limit.

(croft query on the command line is different: it shows 50 rows unless --limit, and says how many were left out.)

Nothing was changed; retrying the same query fails the same way.

What to do: change the app's code.
- ask for less: aggregate in SQL, filter, select fewer or smaller columns;
- page: LIMIT and OFFSET, or better WHERE on a key (WHERE id > last_id ORDER BY id LIMIT 1000);
- pass a larger { limit } to query() when the app really needs that many rows at once, within serve.maxRows. Raising
  serve.maxRows or serve.maxBytes in croft.json is the user's decision.
