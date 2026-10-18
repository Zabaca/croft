# HTTP_ERROR: a request an asset made failed

An ingest's rows() (or a transform's) called ctx.http.get, post, head or getBytes, or a file ingest downloaded a
URL, and the request did not succeed: the server answered with an error status, did not answer in time, could
not be reached, or answered with a body that is not JSON where res.json() needed JSON.

croft already retried what is worth retrying: network errors, timeouts, 429 and 5xx answers, three times with
backoff, waiting as long as Retry-After asks (up to 5 minutes). A TS step that still fails with a retryable error
is attempted again by the run (after 30 s, then 2 min). A longer Retry-After ends the step at once, with
nextRetryAt; until then croft run <asset> holds the asset (HTTP_WAIT) rather than spend a request on the same
429. retryable says whether the same command may simply succeed later. details: method, url (secrets
redacted), status, attempts, retryAfterMs, requestIndex, and the start of the response body.

The step's effect says what was written: normally nothing, and the cursor did not move, so the next run fetches
the same window again.

A status the code expects is not an error: http.get(url, { okStatus: [404] }) returns the 404 as a response
(res.status) for the code to handle, without retrying it. Use it to ask "does this exist", rather than a
.catch() that would also swallow 429s, 5xx and timeouts and keep spending requests. A 304 (the answer to a
request sent with If-None-Match or If-Modified-Since) is always a response.

What to do: it depends on the status.
- 401: the API rejected the credentials. Ask the user to check or replace the secret in .env (never read .env).
- 403: the token lacks a permission, or the body names a rate limit.
- 404: the URL or a path parameter in the asset is wrong; fix the asset. If a 404 is an answer the code
  expects, list it in okStatus.
- 429 or 5xx, timeouts, network: the service is failing or slow; run again later (croft run <asset>). A 429 on
  every run means fetching fewer pages per run; if the API states its limit (so many requests an hour or a
  day), ask the user to put it in croft.json as http.budgets, so croft stays under it across runs.
- Other 4xx: the body says what the API disliked, usually a query parameter.
croft logs <asset> --failed shows the requests of the failed step. Fix, then croft preview <asset> before a run.
