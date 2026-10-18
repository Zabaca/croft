# HTTP_BUDGET_SPENT: a request was not sent because its host's request budget is spent

croft.json can cap the requests ctx.http sends to a host, across every run and preview of the project:

  "http": {"budgets": {"api.example.com": {"perHour": 50, "perDay": 125}}}

perMinute, perHour and perDay each count the requests in any rolling window of that length, retries included,
in .croft/runs.sqlite. Before each request to a budgeted host, ctx.http checks that every window has room. When
one is full, the request is not sent. If the budget frees within 5 minutes, ctx.http waits for it, as it waits
for a server's Retry-After; otherwise the request fails with HTTP_BUDGET_SPENT.

The step stops as it would for a long Retry-After: rows the step already saved in parts stay saved, and nothing
else is written. The step's nextRetryAt is when the budget frees. details: method, url, host, window, limit,
used, freeAt (when the next request may go), retryAfterMs, requestIndex. The refused request cost nothing
against the API's quota.

Until the budget frees, croft run <asset> holds the asset (HTTP_WAIT) instead of trying again, and the scheduler
waits too.

What to do:
- Run it again after freeAt (croft run <asset>). A cursor ingest goes on from what it saved.
- If the API allows more than the budget says (a new plan, a raised limit), ask the user to raise
  http.budgets.<host> in croft.json. A raised budget is honored at once, holds included.
- If every run spends the budget, make each run ask for less: fewer pages per run, a cursor so each run only
  fetches what is new, or a check of what the table already has (ctx.query) before requesting it again.
