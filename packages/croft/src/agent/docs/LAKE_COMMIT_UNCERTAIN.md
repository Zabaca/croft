# LAKE_COMMIT_UNCERTAIN: a write was committing when the connection dropped, and it is not known if it landed

A write step to a lake ends with one commit to the catalog (a Postgres). If the connection drops during that commit, the
step may have landed without the answer reaching croft. croft marks every commit with a tag and, after a drop, asks
the lake whether that tag is there: if it is, the step is done; if not, it runs the step again. This code means the
question itself could not be answered, because the catalog stayed unreachable. details.step names the step and
details.database the lake. retryable is true.

Nothing is half written: the commit is atomic, so the step is either all there or not there at all.

What to do:
- Make sure the catalog is reachable, then look before you run again: `croft status` shows the last write of each
  asset. A step that did not land is safe to run again. One that did land is recognized: running it again finds the
  rows unchanged and writes nothing new for them.
- Do not delete anything in the lake or its catalog by hand to "reset" it.
