# TIMEOUT: work made no progress, or ran longer than its limit

TIMEOUT comes from three places; details.phase says which:
- a step (extract, write, checks): the asset yielded no row and completed no request for its timeout (default
  10 minutes, the asset's timeout: "30m" to change it). A slow page is fine; silence is not. details.rowsSoFar and
  details.lastRequest show how far it got;
- a query over croft serve (phase query): it ran longer than serve.queryTimeoutMs (30 s by default) and was
  stopped;
- croft validate --types (phase types): the project's tsc did not finish.

A step that timed out wrote nothing and its cursor did not move. retryable is false: the same run would most
likely hang the same way.

What to do:
- A step: check that the API answers (croft logs <asset> --failed shows the last request). An API that is just
  slow can get a longer timeout in the asset; one that hangs needs a fix in the code (a request without an await,
  a loop that never yields).
- A served query: make it cheaper (filter, aggregate, add a LIMIT), or ask the user to raise serve.queryTimeoutMs
  in croft.json.
- tsc: run the project's own tsc --noEmit in the project folder to see what it is doing.
