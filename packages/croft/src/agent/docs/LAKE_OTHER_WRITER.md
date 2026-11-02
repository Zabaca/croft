# LAKE_OTHER_WRITER: a different machine has written to this lake (warning)

A lake has one writing machine (croft docs lake). Every write records which machine made it, and `croft doctor`
found that the latest write came from a machine other than this one: details.machine and details.host name it,
details.at says when, details.run the run, details.croft the croft version it ran. Two machines writing the same
lake are not supported: they would not know of each other's runs, and the second one's history, schedule and
crash recovery are its own.

This is a warning, not an error. Reading is not affected, and nothing was changed.

What to do:
- If the other machine is the one that should write from now on (the lake moved), nothing is wrong: run croft from
  that machine only, and stop the scheduler on this one (`croft schedule off`).
- If both machines run croft on this project, stop one of them. Ask the user which one keeps the lake before
  stopping anything: a scheduler on the other machine is theirs to turn off.
- The warning clears itself after this machine's next write.
