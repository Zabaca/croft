# HTTP_WAIT: the asset is held until the API's stated wait is over (warning)

The asset's last step was told to wait. Either the server answered with a Retry-After longer than croft waits
inside a run (HTTP_ERROR with details.retryAfterMs), or its host's request budget in croft.json was spent
(HTTP_BUDGET_SPENT). Running it again before then would only spend a request on the same answer. So croft run
<asset>, a bare croft run and croft run --dry-run hold the asset: its step is skipped with this warning, and its
table and saved position stay as they are. What reads it still runs, reading the table as it is. The run exits 0.

details: until (when the wait is over), code (HTTP_ERROR or HTTP_BUDGET_SPENT), runId (the run that was told),
status (the HTTP status that asked to wait), host (the budgeted host).

A budget's wait is checked again each time, so it ends early once the budget has room (a raised budget in
croft.json, or older requests leaving the window). A server's wait lasts until the time it gave. The scheduler
waits too: a fire that comes inside the wait stays due and runs once it is over. croft preview <asset> is not
held: it is the way to try now, and its requests count against the budget like a run's.

What to do: wait until details.until, then croft run <asset>. Do not loop on croft run in the meantime. If the
API allows more than a budget says, ask the user to raise http.budgets.<host> in croft.json.
