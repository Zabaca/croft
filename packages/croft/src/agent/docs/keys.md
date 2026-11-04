# Keys: a read-only key for each person who reads the project's shared tables

An app reads through croft serve with its token and sees every table. A person gets a key of their own instead: it
reads only the tables the project shares, read-only, over the same HTTP API, and the user can take it away with one
command. A key works only when croft serve runs in server mode (croft docs server-mode), where every query of a person
has two walls: the gate that checks the SQL, and the readers' process, whose views hold only the shared tables. Without
server mode a valid key is refused with a 403 (SERVE_KEY_NEEDS_SERVER_MODE), before its body is read. In server mode the
same key also signs a person's own DuckDB 2.0 in over Quack (croft docs quack).

Giving a person access to data is the user's decision, so `croft serve key add` is on the skill's "Ask the user
first" list: show them which tables the key will read, and wait for a yes. Removing a key needs no asking.

## Setting it up

1. Name the tables people may read, by asset name, in croft.json. They are reviewed like code, and with none named
   every key query is refused (SERVE_NO_SHARED_TABLES), so turning keys on never exposes a table by accident:

     "serve": { "sharedTables": ["orders", "customers"] }

   croft serve reads croft.json when it starts: after changing the list, the user restarts croft serve. A name no
   asset makes (a typo) shares nothing; croft serve key add and list, and croft serve's banner, name it.
2. The user turns server mode on ("serverMode": {"enabled": true} in croft.json, which also changes what apps see:
   croft docs server-mode) and starts croft serve in their own terminal (croft docs serve). Keys are made and removed
   whether or not it runs, and whether or not server mode is on: croft serve key add and list say that a key is refused
   until it is, so a person can be set up first.
3. Make a key for one person:

     croft serve key add alice            prints the key once
     croft serve key add alice --json     data.key holds it, once; the other fields say what it reads

   croft keeps only a hash of the key, in .croft/serve-keys.json (mode 0600), never in croft.json, git, the warehouse
   or a backup. A key cannot be shown again: lose it and make another. Hand it to the person (or the program) it is
   for, and do not copy it into a log, a chat or a file in the project.
4. The person sends it as `Authorization: Bearer <key>` to croft serve's POST /query (croft docs serve), or gives it
   to `query()` from @zabaca/croft/read as the token:

     const url = "http://127.0.0.1:7447";
     const rows = await query("SELECT day, revenue FROM daily_revenue", [], { url, token: key });

## What a key can do

- Read the shared tables: SELECT with filters, aggregates, joins, CTEs and subqueries over them, DESCRIBE and SUMMARIZE
  of one, and SHOW TABLES, which lists the shared tables and no others.
- Nothing else. Any other table, named directly, in a subquery, in a CTE or a scalar subquery, with a schema or a
  catalog name, or with the case changed, is refused (QUERY_PATH_DENIED) in the words for a table that does not
  exist, so a key cannot tell a hidden table from an absent one. Files, URLs, settings, DuckDB's catalog views, croft's
  own tables, anything that writes or changes DuckDB, more than one statement, and SHOW TABLES FROM another schema
  are refused too.
- /status and /health need the app token: a key on them is a 403 (SERVE_UNAUTHORIZED).
- The app token is unchanged. It reads every table, as it always did.

Answers follow the same limits as the app token's: serve.maxRows and serve.maxBytes (a result past one fails with
QUERY_TOO_MANY_ROWS, never cut short), serve.queryTimeoutMs and serve.maxConcurrent. A key's query runs on the
readers' process, against one view per shared table of the read copy (every answer says asOf); it never waits for a
run. Over a lake there is no copy: the views read the lake's last snapshot, so a person sees each commit on their next
query (croft docs lake). The app token also runs there in server mode, and otherwise on croft serve's query worker, which steps aside for
writes.

## Managing keys

  croft serve key list                 names, when each was made and last used (never the key); --json too
  croft serve key remove alice         refused on its very next request

Both work with croft serve running or not. croft serve checks the keys file on every HTTP request, so a key removed (or
added) while it runs is honoured at once, with no restart. A DuckDB session over Quack outlives a request, so croft serve
reads the file every 250 ms and hands the readers' process the list: a removed key is refused on its session's next
query within a second, and a key just added may take a quarter of a second to sign in. A keys file that cannot be read means no key is accepted
(SERVE_KEYS_UNREADABLE says why), and a name has one key (SERVE_KEY_EXISTS).

## The log

croft serve writes one line to its stderr for every key query, answered or refused: the key's name, the time, the
tables it read, the rows and how long it took, and for a refusal the problem's code. Never the SQL and never the key:

  croft serve: key alice  2026-11-01T10:00:00-08:00  read orders, customers  3 rows  12 ms
  croft serve: key alice  2026-11-01T10:00:05-08:00  refused QUERY_PATH_DENIED  0 rows  1 ms

A key query over Quack gets a line of the same kind, marked `over Quack`, without the rows and the time, which only the
client sees (croft docs quack).
