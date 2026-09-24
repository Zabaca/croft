# INPUT_NEEDS_KEY: newRows() on an input that has no key

An incremental TypeScript transform reads its inputs with newRows(), which hands over each input row once and
remembers where it stopped as (_loaded_at, key): the stamp of the last row it processed, and that row's key.
One write stamps every row it changes with the same _loaded_at, so the key is what tells those rows apart. An
input without a key gives newRows() nothing to remember its place by.

What to do, one of:
- Give the input a key: key: "id" in its TS config, or -- key: id in its SQL header. Pick the column, or
  columns, that identify a row; croft then checks that they are unique and never NULL.
- Read that input with rows() or ctx.query() instead, when the transform only looks things up in it.

croft validate reports this before a run, for the newRows("name") calls it can see in the code; a run reports
it when the code first calls newRows() on the input.
