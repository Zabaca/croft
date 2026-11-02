# QUACK_LISTEN_FAILED: croft serve could not listen for DuckDB clients

In server mode (croft docs server-mode) croft serve's readers' process listens for DuckDB 2.0 clients over Quack
(croft docs quack), on `serverMode.quackHost` and `serverMode.quackPort` (127.0.0.1 and 9494 by default). DuckDB
would not start that listener: usually the port is in use by another program, sometimes the address is not one of
this machine's. details.uri is the address and details.quack is DuckDB's first line of explanation.

croft serve does not start without it (the HTTP API and the keys depend on the same process). When it was running
and its readers' process was replaced, it answers HTTP queries with this error until the listener can start.
Nothing was written, and the project's data was not touched.

What to do:
- Ask the user which port Quack should use. Stopping another program, or choosing a port, is their decision.
- Set it in croft.json, then restart croft serve (which the user starts in their own terminal):

    "serverMode": { "enabled": true, "quackPort": 9495 }

  A port of 0 picks a free one on every start, which suits a test and not a team: the address then changes whenever
  the readers' process restarts, and clients cannot come back to it. `quackHost` takes an address of this machine.
- A readers' process that croft serve restarts takes the same port again at once [V: macOS arm64]; a failure after
  a restart means another program took the port in between.
