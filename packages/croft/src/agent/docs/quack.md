# Quack: a person's own DuckDB 2.0 reads the shared tables

In server mode (croft docs server-mode) croft serve also listens for DuckDB 2.0 clients over Quack, DuckDB's remote
protocol. A person with a key (croft docs keys) attaches from their own DuckDB, names the shared tables as they would
any table, and DuckDB sends the filters and aggregates to croft serve. The same key works on the HTTP API. Everything
comes from the read copy, as of the end of the last run that changed data, and a person can read that time from the
database itself.

Quack exists only in server mode. Without `"serverMode": {"enabled": true}` there is no listener.

## Giving a person access

Giving a person access to data is the user's decision, so `croft serve key add` is on the skill's "ask the user first"
list. Once the user has said yes:

1. The user names the tables people may read in `serve.sharedTables` in croft.json and restarts croft serve (croft docs
   keys). With none named, every query of a key is refused, and an attach fails with that message.
2. `croft serve key add alice` prints the key once. With server mode on it also prints how to attach, and `--json` has
   the same under `data.quack` (`uri`, `attach` with the key in it, `asOfView`, `loopback`):

     ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN 'croftkey_…');
     SELECT count(*) FROM croft.orders;
     SELECT as_of FROM croft._croft_as_of;

   The address is `serverMode.quackHost` and `serverMode.quackPort` (127.0.0.1 and 9494 by default; a port of 0 picks a
   free one, which croft serve's banner and `data.quack.uri` of `croft serve --json` show). The key reaches croft serve
   within 250 ms of `key add`, so a first attach in the same second may be told `Authentication failed`: try again.
3. `croft serve key remove alice` ends it. An open DuckDB session of that key is refused on its next query, within a
   second, with `the key alice was removed`; other people's sessions are not affected.

Only DuckDB 2.0 clients speak Quack. This build is tested with the Node and Bun library (`@duckdb/node-api` 2.0.0-r.1);
the DuckDB command line is named as a client once a test with a 2.0 command line passes, and the one installed on a
development machine is often 1.x, which predates Quack. Use the library, or Python on DuckDB 2.0.

## What a client sees

- The main schema, the shared tables and `_croft_as_of`, all views of the read copy. The name starts with an
  underscore, which no table's name can, so it never collides with one. croft's own schema (`_croft`) never appears,
  and a table that is not shared is as absent as one that does not exist.
- `SELECT as_of FROM croft._croft_as_of` is one row: the time of the copy, rebuilt at every swap of a refreshed copy.
  The client shows it in its own time zone; `epoch_ms(as_of)` is the instant.
- DuckDB's list of all tables (`SHOW ALL TABLES`, or `duckdb_tables()`) comes back empty for them, because they are
  views. `SHOW TABLES FROM croft`, `duckdb_views()` and `DESCRIBE croft.orders` list and describe them.
- Filters and aggregates are sent to croft serve, which runs them on the copy; a join with the client's own tables
  runs in the client. There is no row limit on Quack (a limit that adds a LIMIT to the query would cut a join short with
  no sign, and croft never cuts an answer short silently). A query that runs too long is stopped instead, below.

## What is refused

Everything but reading: INSERT, UPDATE, DELETE, DROP, CREATE, `COPY`, EXPORT, ATTACH and DETACH, INSTALL and LOAD, SET,
PRAGMA and CALL, reading a file or a URL, croft serve's own files, settings and environment, stopping the server,
several statements at once, a table that is not shared however it is named (with a catalog or schema, with the case
changed, in a CTE, a subquery, a UNION or a LATERAL join), `query_table`, DuckDB's system views and `information_schema`.
The refusal reaches the client as `Authorization callback failed: <message> [CODE]`, with the codes and words of the
HTTP API (`QUERY_NOT_SELECT`, `QUERY_PATH_DENIED`, `SQL_NOT_ONE_STATEMENT`, `SQL_SYNTAX`), and a table that is not
shared gets the words for one that does not exist. Nothing is written anywhere. It is the same synchronous check as
over HTTP (croft docs keys), so the two cannot drift.

The queries a DuckDB client sends when it attaches are let through by their exact text: the transaction control, and
two catalog queries that croft swaps for ones that list only the shared views. A text that differs by a byte (a trailing
space, a comment, a second statement) is an ordinary query and is refused. The two texts belong to the quack build croft
pins, so each upgrade of that build needs them captured again; until then attaching fails closed.

## Time limit, and dropped sessions

A query that runs past `serve.queryTimeoutMs` (30 s by default) ends the readers' process, because Quack cannot cancel
a query on the server. That drops every session on it, not only the slow one's. croft serve starts another process at once
(about half a second, mostly checking the extension files again). Meanwhile, and after, a client that stays attached gets
an error on every query, `Could not connect to server` while the new process starts and `Invalid connection id` after, and
never a wrong answer. It carries on by attaching again:

  DETACH croft;
  ATTACH 'quack:127.0.0.1:9494' AS croft (TOKEN 'croftkey_…');

which takes about 12 to 40 ms. With `serverMode.quackPort` set to 0 the new process picks a new port, so use a fixed port
wherever clients are meant to come back.

A swap of a refreshed copy does not drop sessions. A query that arrives in the few milliseconds between the old copy being
detached and the new one attached can fail with `Catalog Error: Table with name "wh.main.orders" does not exist`:
run it again.

## One thing to know about DuckDB 2.0

Two connections that share one `ATTACH`, each with a transaction open, fail with `cannot start a transaction within a
transaction`, and once that invalidated the client's database (a fatal error) [V: DuckDB 2.0.0, the option's tests]. A
program that keeps several connections open on one DuckDB should give each its own ATTACH, or not open explicit
transactions on them. This is DuckDB's client, not croft's; croft does nothing to prevent it.

## The address, and a proxy

The listener is on the machine itself (127.0.0.1) unless `serverMode.quackHost` says otherwise. Any other address
prints a warning in croft serve's banner and in `croft serve --json` (`data.quack.loopback` is false): an HTTPS reverse
proxy belongs in front, as for the HTTP API. For such an address croft turns Quack's own TLS off (`allow_other_hostname`,
`disable_ssl`), so the proxy holds the certificate and speaks plain HTTP to Quack, and a key crosses the network in the
clear if there is none.

Quack works through a reverse proxy with the port written out in the address: a client attaches to
`quack:<the proxy's name>:443`, not to a bare name. If the proxy is Cloudflare Access, a client sends its service token
with an HTTP secret scoped to the proxy's URL; DuckDB then sends the headers on every request (tested through a recording
proxy):

  CREATE SECRET access (TYPE http, EXTRA_HTTP_HEADERS MAP {'CF-Access-Client-Id': '…', 'CF-Access-Client-Secret': '…'},
    SCOPE 'https://croft.example.com');

## The log

croft serve writes one line to its stderr for every key query over Quack, answered or refused, beside the HTTP ones:

  croft serve: key alice  2026-11-01T10:00:00-08:00  read orders, customers  over Quack
  croft serve: key alice  2026-11-01T10:00:05-08:00  refused QUERY_PATH_DENIED  over Quack

The key's name, the time, the tables read, or the refusal's code; never the SQL and never the key. Quack calls croft's check
before a query runs, so unlike an HTTP line it has no row count or time. `croft serve key list` shows a key's last use,
a Quack sign-in or query included.
