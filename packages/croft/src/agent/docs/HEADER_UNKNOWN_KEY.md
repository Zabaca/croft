# HEADER_UNKNOWN_KEY: an SQL header line with a name croft does not know

The header of an SQL asset is the run of `-- name: value` lines at the top of the file, and it takes four
names: description, key, check and warn. A line such as `-- chek: amount >= 0` has a colon after its first
word, so croft reads it as a header line, and chek is none of the four. The rest of the header still counts.

What to do:
- A misspelled name: apply the fix, which renames it to the name it is closest to (chek → check).
- A plain comment that happens to start with "word:": reword it without the colon after the first word
  (-- Note that ... rather than -- Note: ...).
- The header is only the lines at the very top, before any SQL. A -- key: or -- check: line further down is not
  part of it: move it up into the header.

croft docs sql describes the whole file, and croft docs checks the check language.
