# QUACK_PLAINTEXT_NOT_ACCEPTED: Quack would listen beyond this machine, in plaintext

In server mode croft serve listens for DuckDB 2.0 clients over Quack (croft docs quack) on `serverMode.quackHost`,
which is 127.0.0.1 by default. The project names another address, one that is not this machine only. Quack there
serves TLS with a certificate of its own, which a plain client cannot use, so croft turns it off and expects an HTTPS
reverse proxy of your own in front. Without one, keys and queries cross the network in the clear. croft will not do
that by accident, so it does not start. details.uri is the address.

Nothing was written, and the project's data was not touched. The HTTP API did not start either: it is the same process.

What to do:
- A reverse proxy on this machine connects to 127.0.0.1 and needs nothing else. Ask the user whether that is all they
  want, and if so remove "quackHost" from croft.json, then restart croft serve.
- If the user does want Quack beyond this machine, behind an HTTPS reverse proxy they run, it is their decision, and
  they set it in croft.json:

    "serverMode": { "enabled": true, "quackHost": "0.0.0.0", "quackPlaintextOnNetwork": true }

  The banner and `croft serve --json` then keep warning that a proxy belongs in front. Never set it yourself.
