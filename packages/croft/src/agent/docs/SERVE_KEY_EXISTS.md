# SERVE_KEY_EXISTS: a key with that name already exists

croft serve key add makes one key per name. A key cannot be shown again (croft keeps only a hash), so the old one is
neither replaced nor revealed. Nothing was changed.

What to do:
- For another person or program, pick another name.
- To replace a key whose person lost it, or should lose access: croft serve key remove <name>, then croft serve key add
  <name> again. The old key stops working on its next request. Taking a key away needs no asking; making the new one
  does (it shares data), so ask the user first.
