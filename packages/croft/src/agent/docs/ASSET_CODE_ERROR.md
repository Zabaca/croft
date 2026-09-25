# ASSET_CODE_ERROR: the asset's own code threw an error

The asset's rows(), map() or a helper it calls threw while the step ran: a TypeError on a field that is missing,
a failed parse, a check the code does itself. details.stack holds the stack, trimmed to the frames in assets/ and
lib/, so the first line of it is where to look. A map() failure also gives details.row and details.input, the row
it received.

An asset can also stop itself on purpose with fail("CODE", "message") from @zabaca/croft: croft reports that as
ASSET_CODE_ERROR with details.requestedCode (only KEYSET_STUCK keeps its own code).

Nothing was written for the step, and its cursor did not move. Its downstream assets are skipped in this run.

What to do:
- Read croft logs <asset> --failed: the stack, and everything the code logged with ctx.log.
- Fix the code where the stack points. A field that is sometimes missing needs a guard (row.user?.login ?? null).
- For data the code rejects on purpose (fail), fix what the message describes, in the code or in the source.
- Then croft preview <asset> to try it on real data without writing anything, and croft run <asset>.
