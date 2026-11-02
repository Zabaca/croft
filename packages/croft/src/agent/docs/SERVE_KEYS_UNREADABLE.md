# SERVE_KEYS_UNREADABLE: croft cannot read the file that holds the keys' hashes

croft keeps one hash per key in .croft/serve-keys.json. When that file cannot be read, is not JSON, or is not a
keys file, croft serve accepts no key (it fails closed; the app token still works), and the key commands refuse to
change the file rather than overwrite what may be a person's keys. details.file names it.

What to do:
- Tell the user. Restoring the file is theirs to do: put back a copy of it from a backup of the state folder, which is
  not part of croft backup, or remove it, which cancels every key.
- After removing it, make the keys again (croft serve key add <name> for each person, asking the user first; the
  old keys cannot be recovered, so each person needs a new one).
