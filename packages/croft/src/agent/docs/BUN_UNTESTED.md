# BUN_UNTESTED: this Bun is newer than any Bun this croft was tested on (warning)

croft is tested on the Bun versions it supports, from its floor to the newest one at its release. croft doctor
warns when the Bun running it is newer than that: croft usually works, but a change in Bun could break something
(details.bun, details.tested).

Nothing is blocked.

What to do: nothing, unless something misbehaves. If a command fails in a way that looks like a runtime problem
(a crash, a missing API, INTERNAL_ERROR), mention this warning when reporting it, and ask the user whether to try the
tested Bun version (the hint gives the install command) or a newer croft.
