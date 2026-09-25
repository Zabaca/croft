# HTTP_ERROR: a request an asset made failed

An ingest's rows() (or a transform's) called ctx.http.get or ctx.http.post, or a file ingest downloaded a URL, and
the request did not succeed: the server answered with an error status, did not answer in time, could not be
reached, or answered with a body that is not JSON where res.json() needed JSON.

croft already retried what is worth retrying: network errors, timeouts, 429 and 5xx answers, three times with
backoff, waiting as long as Retry-After asks (up to 5 minutes). A TS step that still fails with a retryable error
is attempted again by the run (after 30 s, then 2 min). retryable says whether the same command may simply succeed
later. details: method, url (secrets redacted), status, attempts, retryAfterMs, requestIndex, and the start of the
response body.

The step's effect says what was written: normally nothing, and the cursor did not move, so the next run fetches
the same window again.

What to do: it depends on the status.
- 401: the API rejected the credentials. Ask the user to check or replace the secret in .env (never read .env).
- 403: the token lacks a permission, or the body names a rate limit.
- 404: the URL or a path parameter in the asset is wrong; fix the asset.
- 429 or 5xx, timeouts, network: the service is failing or slow; run again later (croft run <asset>). A 429 on
  every run means fetching fewer pages per run.
- Other 4xx: the body says what the API disliked, usually a query parameter.
croft logs <asset> --failed shows the requests of the failed step. Fix, then croft preview <asset> before a run.
