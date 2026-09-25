# CSV_HEADER_AMBIGUOUS: croft cannot tell whether a CSV file's first line is its header

A file ingest reads CSV and TSV files with DuckDB's sniffer, but croft does not let a guess lose data silently.
CSV_HEADER_AMBIGUOUS comes in two forms; the message quotes the first lines of the file:
- every column reads as text, so the first line could be column names or the first row of data. Guessing
  "header" would drop that row if it is data;
- DuckDB would skip some lines before the header. They may be a preamble (a title, an export date), or they may be
  data in rows of another length.

Nothing was loaded for the step.

What to do: look at the quoted lines and declare what they are in the asset's csv options:
- the first line holds column names: csv: { header: true };
- the first line is already data: csv: { header: false } (the columns get generated names; map() can rename
  them);
- the first lines are a preamble: csv: { skip: 2 } (the number the message gives); if they are data, the file has
  rows of different lengths and needs fixing at its source.
Then croft preview <asset> shows the header croft used and the rows, and croft run <asset>.
