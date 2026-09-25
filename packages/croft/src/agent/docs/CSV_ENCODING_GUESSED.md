# CSV_ENCODING_GUESSED: a CSV file was not UTF-8, so croft guessed its encoding (warning)

A file ingest reads CSV and TSV as UTF-8. A file that is not valid UTF-8 is read as UTF-16 when it starts with a
UTF-16 byte-order mark, and as Latin-1 otherwise, which is what Excel and many older exports use. croft warns
because the guess can be wrong: accented letters would then look wrong (Ã© for é). details: file, encoding.

The file was loaded with the guessed encoding.

What to do: look at a few text values with accents (croft query on the table, or croft preview <asset>). If they
look right, declare the encoding in the asset so the warning stops: csv: { encoding: "latin-1" } (or "utf-16"). If
they look wrong, declare the right one; for an encoding croft does not read, ask the user to re-export the file as
UTF-8. Values already loaded wrongly come right when the files load again (croft run <asset>, or a reload of all
files).
