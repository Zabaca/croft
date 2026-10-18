# FILE_UNREADABLE: a file ingest found a file it cannot read

The file exists, but croft cannot read it in its format: a JSON or YAML file that does not parse, an NDJSON line
that is not a JSON object, a JSON, NDJSON or YAML file that is not UTF-8, a CSV that DuckDB cannot read with one
dialect, a truncated or corrupt file, or a file croft has no permission to open. The message quotes DuckDB's or the
parser's words, and details.file (with details.line for NDJSON) says where.

For a CSV, the hint says how sure croft is:
- it names a line ("does not have the same columns as its header"): a strict read found that line has more or
  fewer fields than the header;
- it says DuckDB found no one delimiter, quote and header that fit every line: the cause is one of several, most
  often a line with more or fewer fields, a quote that is never closed, or lines before the header. Look at the
  file before deciding which.
Lines that end in CRLF and LF in one file are not a cause: croft reads such a file with one kind of line ending.

Nothing was loaded for the step; files loaded before keep their rows.

What to do:
- Look at the file around the place named. A partial download or an export still being written is the usual
  cause: wait for it, or ask the user for a complete copy.
- A JSON file with one object per line: set format: "ndjson" in the asset.
- A CSV with a preamble or odd delimiters: declare csv: { delimiter, header, skip } in the asset (croft docs
  ingest). A file in another encoding than UTF-8: csv: { encoding: "latin-1" }; JSON and YAML must be UTF-8.
- A bad file that should not be loaded: narrow the glob so it does not match it, or ask the user to fix or remove
  it.
Then croft preview <asset>, and croft run <asset>.
