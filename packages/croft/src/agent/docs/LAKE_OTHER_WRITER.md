# LAKE_OTHER_WRITER: a different machine has written to this lake (warning)

A lake has one writing machine (croft docs lake). Every machine that writes keeps a record of its last write in the
lake, and `croft doctor` found that another machine has written since this machine's last write (or, at this
machine's last write, found that one had written in between): details.machine and details.host name it, details.at
says when, details.run the run. Two machines writing the same lake are not supported: they would not know of each
other's runs, and the second one's history, schedule and crash recovery are its own.

This is a warning, not an error. Reading is not affected, and nothing was changed.

What to do:
- If the other machine is the one that should write from now on (the lake moved), nothing is wrong: run croft from
  that machine only, and stop the scheduler on this one (`croft schedule off`).
- If both machines run croft on this project, stop one of them. Ask the user which one keeps the lake before
  stopping anything: a scheduler on the other machine is theirs to turn off.
- The warning clears itself at this machine's next write that finds no other machine's write since its last one.
