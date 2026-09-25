# RUN_CRASHED: the process running a step died before its write committed

A run's process ended without finishing its step: it was killed (kill -9, the machine slept or rebooted, it ran
out of memory), or a scheduled run never started. The next croft command that writes finds the step in
runs.sqlite and checks it against the warehouse; croft status and croft logs --runs show it as crashed.

Nothing of the crashed step was saved: croft writes a step in one transaction, and cursors move only when it
commits, so no data is skipped. Parts a long first load had committed, or chunks an incremental transform had
committed, are kept. retryable is true.

What to do: run the asset again: croft run <asset>. It continues from what was committed. If it crashes again,
croft logs <asset> shows its last output; a process killed for memory needs smaller pages or batches in the asset
code. A scheduled run that did not start runs again by itself after a wait; croft logs --runs lists the attempts.
