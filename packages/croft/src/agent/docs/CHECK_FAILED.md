# CHECK_FAILED: rows broke a blocking check, and nothing was written

Blocking checks run inside the write, after the rows are in place and before the commit. When one fails, the
whole write rolls back: rows, new columns and the saved cursor alike. The table keeps its previous rows, and the
run exits 3 when checks were all that failed.

    error CHECK_FAILED  assets/open_issues.sql
          not_null(author): 3 of 4,211 rows
            id=2291  title="Crash on Windows when …"  author=NULL
            id=2307  title="bun test hangs with …"  author=NULL
          fix: correct assets/open_issues.sql or the data, then: croft run open_issues
          effect: nothing was written; open_issues keeps its previous 4,208 rows

The message shows 3 sample rows. In --json the problem's details have check, failing (how many rows fail),
checked, scope and sample (up to 20 rows). Other blocking checks that failed are listed as "also failing".

What to do:
1. Read the sample rows: they say which rows are wrong and why.
2. Decide what is wrong:
   - the asset's code or SQL makes bad rows: fix the file;
   - the source data is bad: fix it upstream, or filter or clean those rows in the asset;
   - the check is wrong: weakening or deleting it changes what the table promises, so ask the user first.
3. croft run <asset> again. croft preview <asset> shows the check results without writing anything.

Some cases:
- unique(...) counts the rows that share a value with another row (rows with a NULL in the columns are left
  out). An SQL asset or a TypeScript transform whose result holds a key twice fails unique(key) as well: add
  the missing key column, or remove the duplicates in the query or code.
- An incremental TypeScript transform commits in chunks: only the failing chunk is rolled back, and earlier
  chunks stay. The next attempt reuses the failed chunk's rows while the code, the checks and the input rows are
  unchanged, so fix one of those.
- A failing warning (-- warn:, warnings: [...]) is a CHECK_FAILED with severity warning: the write stands.
