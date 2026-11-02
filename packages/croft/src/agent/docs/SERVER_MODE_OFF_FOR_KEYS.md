# SERVER_MODE_OFF_FOR_KEYS: a key is refused until server mode is on (warning)

A person's key works only when croft serve runs in server mode (croft docs keys, croft docs server-mode), where every
query has two walls: the gate, and views that hold nothing but the shared tables. `croft serve key add` or `key list`
found `serverMode.enabled` off in croft.json. The key was made all the same, so a person can be set up first, but
croft serve refuses it with a 403 (SERVE_KEY_NEEDS_SERVER_MODE) until server mode is on. Nothing failed, and the exit
is 0.

Nothing else was written. The app token is not affected.

What to do:
- Ask the user whether people should read through croft serve in server mode. It changes what apps see too: they read
  the read copy, as of the end of the last run that changed data (croft docs server-mode).
- If the user says yes, set it in croft.json and ask them to restart croft serve in their own terminal:

    "serverMode": { "enabled": true }

  The key does not have to be made again.
- If not, remove the key with croft serve key remove, which needs no asking.
