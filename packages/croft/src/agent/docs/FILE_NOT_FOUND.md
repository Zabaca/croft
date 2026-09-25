# FILE_NOT_FOUND: a file ingest's path or glob matches no file

A file ingest reads file: "files/sales/*.csv" (a path, a glob, a list of them, or a URL), relative to the project
folder. FILE_NOT_FOUND means that on this run:
- a path names a file that does not exist, or a folder (a folder needs a glob: files/sales/*.csv);
- a glob matches no file at all, and the asset has never loaded one.

A file that was loaded before and is gone now is not this error: the run reports it as gone.

Nothing was loaded for the step.

What to do:
- Check the path in the asset against the files: it is relative to the project folder, not to assets/. Input
  files belong under files/.
- The files have not arrived yet (an export not saved yet, a sync not finished): ask the user where they are, then
  croft run <asset> again.
- For a download, use the URL itself in file: a URL that answers with an error is HTTP_ERROR.
