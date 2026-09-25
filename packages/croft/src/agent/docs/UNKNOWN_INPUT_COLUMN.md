# UNKNOWN_INPUT_COLUMN: a TypeScript transform read a column its input does not have

The rows that rows(), newRows() and ctx.query() hand to a transform are guarded: reading a column the input does
not have throws, instead of giving undefined. Without the guard, a column renamed upstream would be stored as
NULL and pass every check. The message suggests the closest name:

    github_issues has no column "author"; did you mean "author_login"?

The step wrote nothing (an incremental transform keeps the chunks it committed earlier).

croft validate --types finds the same mistake before anything runs. croft writes each input's row type to
.croft/types after every run and preview, so tsc reports code that reads a column its input does not have
through rows("x"), newRows("x") or query<"x">(sql), at the line that reads it, with the same suggestion. An
SQL input's columns are taken from its code as it is now, so a column renamed in SQL is caught before the run.
That needs the generated type to reach the code: read with rows("x") or newRows("x") with no type argument, as
croft new transform writes it. An explicit row type, as in newRows<Issue>("x"), replaces the generated one, so tsc
checks the code against Issue and only the run finds the rename; keep one for column names computed at run time
(rows<Row>("x")). The project's tsconfig.json must include .croft/types too (croft init writes it that way, and
croft validate --types says when it does not).

What to do:
- The column was renamed upstream: read the new name. The fix edits the line when it can find it, and
  croft describe <input> lists the input's columns (so does .croft/types/<input>.d.ts). After
  const { author } = row, read { author_login: author }, which keeps the variable's name.
- The column never existed: check the input's columns and correct the code.
- A column that exists but is NULL in a row reads as null; only a column the input does not have throws.

Guarded rows work with spread ({ ...row }), JSON.stringify, Object.keys and `in`. structuredClone(row) does
not: copy with { ...row }.
