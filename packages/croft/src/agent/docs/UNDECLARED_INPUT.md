# UNDECLARED_INPUT: a TypeScript transform reads a table that is not in its inputs

A transform lists the assets it reads in inputs. croft builds them first, updates the transform when they
change, and snapshots only them for the code. Reading any other table, with rows(), newRows() or in a
ctx.query() SELECT, is refused, because croft would not know the transform depends on it.

What to do:
- Add the table to inputs; the fix shows the new list: inputs: ["github_issues", "labels"].
- A misspelled name: the hint names the input it is closest to.
- The transform's own table: a transform computes its table from its inputs and never reads it. For work that
  builds on what was done before, make it incremental (incremental: true, newRows()): rows it has already
  processed are not handed over again.
