# croft serve: a read server for apps, with the scheduler built in

croft serve keeps running and answers SELECT queries over HTTP against the warehouse, read-only. It steps
aside whenever a croft run writes (queries wait for the write, up to 10 s), so apps never block runs, and it
runs no asset code itself. While scheduling is on, it starts a scheduler tick every minute, which makes it
the one command to keep running on a server, in a container or on WSL (croft docs scheduling).

## Starting it (the user does)

croft serve runs until it is stopped, so an agent never starts it in its own shell: ask the user to run it in
their own terminal (it is on the skill's "Ask the user first" list, because it runs scheduled work unattended).

  croft serve                        listens on 127.0.0.1:7447 (serve.host and serve.port in croft.json)
  croft serve --port 0               any free port; the banner and .croft/serve.json give the address

Any address other than loopback (--host 0.0.0.0) exposes data beyond this machine and must sit behind an HTTPS
reverse proxy or tunnel. On a server without the per-user scheduler job: croft schedule on --no-os-job, then
croft serve. Ctrl-C or SIGTERM stops it; apps then read the file directly again.

## Apps

App code reads with the same function in both modes:

  import { query } from "@zabaca/croft/read";
  const rows = await query("SELECT day, revenue FROM daily_revenue WHERE day >= $1", ["2026-09-01"]);

In the project (or an app whose croft project is data/), it finds the running server and its token in
.croft/serve.json; with no server running it opens the file briefly per query. An app elsewhere (Vercel, Fly)
sets CROFT_URL and CROFT_SERVE_TOKEN, and then always uses the server. It works in Bun and Node.

- The token: croft serve writes a random one to .croft/serve.json (mode 0600) at every start. For a token that
  stays the same (hosted apps), the user sets CROFT_SERVE_TOKEN in .env. Never print or copy it yourself.
- Rows come back as croft query --json shows them: HUGEINT, DECIMAL and big integers as strings, timestamps with
  the project offset. More rows than limit (10,000 by default) is QUERY_TOO_MANY_ROWS, never a cut result.
- Only tables of the project can be read: no files, settings or croft's own schemas (QUERY_PATH_DENIED).
- A query runs at most serve.queryTimeoutMs (30 s), and serve.maxConcurrent (4) run at once; the rest queue.
- Browsers: list the page's origin in serve.allowOrigins.

## Over HTTP

Every request needs Authorization: Bearer <token>.

  POST /query   {"sql": "...", "params": [...], "limit": 1000}   the croft query envelope
  GET  /status  the server and its database connection
  GET  /health  {ok, pid, version, database, writeIntent, queriesToday}

## Errors

- SERVE_UNAUTHORIZED: a missing or wrong token (401), or a Host or Origin the server refuses (403). Never
  retried; the app needs the token of the server it talks to.
- SERVE_UNAVAILABLE: the server did not answer, or stayed busy (503 with Retry-After), for the whole timeoutMs
  (10 s by default). A long write step can cause it; "readCopy": true lets the server answer from the read copy
  meanwhile, marked stale: true with asOf (croft docs read-copy).
- SERVE_UNSAFE_FILESYSTEM: the database is on a network or VM-shared folder, where the file lock does not hold.
  Every croft process must run on the same machine as the file.
- Starting a second croft serve for the same project is refused while the first runs.
