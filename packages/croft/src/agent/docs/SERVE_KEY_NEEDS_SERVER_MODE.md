# SERVE_KEY_NEEDS_SERVER_MODE: a person's key works only when croft serve runs in server mode

A key (croft serve key add, croft docs keys) is for a person, and it reads only where every query has two walls: the
gate that checks the SQL, and the readers' process, whose views hold nothing but the shared tables (croft docs
server-mode). This croft serve does not run in server mode, so it refuses the key with a 403 before it reads the
request's body. The key is valid, which is why this is not a 401: it will work as soon as server mode is on.

Nothing ran and nothing was written. The app token is not affected: it reads every table, as it always did. A key
removed, or made up, is still a 401.

What to do:
- Ask the user whether people should read through croft serve at all: server mode changes what apps see too. They then
  read the read copy, as of the end of the last run that changed data, and never wait for a run (croft docs
  server-mode). Turning it on is the user's decision, not yours. In a lake project there is no copy: they read the lake's
  last snapshot, and each commit is in their next query (croft docs lake).
- If the user says yes, set it in croft.json and ask them to restart croft serve in their own terminal:

    "serverMode": { "enabled": true }

- Keys can be made, listed and removed before that: croft serve key add and list say the key is refused until server
  mode is on. Nothing has to be made again afterwards.
