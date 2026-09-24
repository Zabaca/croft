# UNKNOWN_INPUT_COLUMN: a TypeScript transform read a column its input does not have

The rows that rows(), newRows() and ctx.query() hand to a transform are guarded: reading a column the input does
not have throws, instead of giving undefined. Without the guard, a column renamed upstream would be stored as
NULL and pass every check. The message suggests the closest name:

    github_issues has no column "author"; did you mean "author_login"?

The step wrote nothing (an incremental transform keeps the chunks it committed earlier).

What to do:
- The column was renamed upstream: read the new name. The fix edits the line when it can find it, and
  croft describe <input> lists the input's columns.
- The column never existed: check the input's columns and correct the code.
- A column that exists but is NULL in a row reads as null; only a column the input does not have throws.

Guarded rows work with spread ({ ...row }), JSON.stringify, Object.keys and `in`. structuredClone(row) does
not: copy with { ...row }.
