# SERVE_NO_SHARED_TABLES: the project shares no table with keys, so a key can read nothing

A key (croft serve key add, croft docs keys) reads only the tables the project names in croft.json under
serve.sharedTables. With none named, every query a key sends is refused, whatever it asks for: turning keys on never
exposes a table by accident. The answer is a 403. The app token is not affected; it reads every table.

Nothing ran and nothing was written.

What to do:
- Ask the user which tables people may read. Sharing data is their decision, and a table shared is readable by every
  key. Never share a table yourself to make a key work.
- Then add them to croft.json, by asset name:

    "serve": { "sharedTables": ["orders", "customers"] }

  and ask the user to restart croft serve, which reads croft.json when it starts.
