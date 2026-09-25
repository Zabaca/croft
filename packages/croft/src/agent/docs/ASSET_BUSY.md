# ASSET_BUSY: another run is working on this asset

Only one run touches an asset at a time: each run takes a lease on the assets it runs, in .croft/runs.sqlite. A
second run of the same asset (a manual run while the scheduler runs it, two terminals, a delete or restore during a
run) waits for the lease, and ASSET_BUSY means that wait ran out, or --no-wait asked not to wait. The message names
the run that holds it (runId, pid) and for how long.

A lease of a process that died is released on its own: croft checks the pid, its start time and the boot id.

Nothing was changed; retryable is true.

What to do: wait for the run that holds the asset, then run again: croft wait <runId> with the id the message
names, then the same command. croft status shows the running runs. A scheduled tick skips a leased asset and runs
it when it is next due, so nothing needs doing for the scheduler.
