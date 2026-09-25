# DB_HELD_BY_OTHER_PROGRAM: a program that is not croft has the warehouse open

A DuckDB file can be open for writing in one process only. Another program has warehouse.duckdb open: the DuckDB
CLI or UI, DBeaver or another GUI, a notebook, or an app that keeps its own connection. croft waited (off a
terminal at most 90 s) and gave up. The message names the program and its PID (details.holder).

Nothing was changed; retryable is true once the program lets go.

What to do:
- Ask the user to close the program the message names (or the query tab that holds the file), then run the command
  again. Do not kill another program's process yourself.
- So it does not happen again:
  - a GUI should open the read copy, warehouse.read.duckdb, never warehouse.duckdb: "readCopy": true in croft.json
    keeps it current (croft docs read-copy);
  - an app should read through @zabaca/croft/read, which opens the file only per query, or through croft serve
    (croft docs serve).
