# CHECK_INVALID: a check croft cannot run

A check is unique(a, b), not_null(a, b), min_rows(n), or one boolean SQL expression over the asset's columns
(croft docs checks). CHECK_INVALID means a check is none of those, or cannot run on this table:
- it does not parse, or it is several expressions (a `,` between them, or a `;`);
- a form of the check language inside a larger expression (not_null(a) OR b > 0), or a near miss such as
  notnull(a), which gets a did-you-mean;
- it names a column the asset does not have, or its types do not fit the data;
- it reads a file, calls a table function that reads files or runs SQL given as text, or uses a parameter.

A blocking check that cannot run stops the write as a failing one does: data a check cannot vouch for is not
committed. A warning that cannot run is reported, and the write stands.

What to do: correct the check in the asset file; the message quotes it, and the fix renames a misspelled
column. croft validate --json checks every check before a run, and binds each check of an SQL asset against the
columns its SELECT returns. Rewrite a check so it says what it meant; removing it instead needs the user's yes.
