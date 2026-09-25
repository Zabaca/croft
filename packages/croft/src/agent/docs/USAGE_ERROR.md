# USAGE_ERROR: the command line asks for something croft cannot do

The command, its arguments or its flags are wrong, or they do not fit the project. Examples:
- an unknown command or flag (with a did-you-mean), a missing or extra argument, a flag without its value;
- a name that is not an asset of this project (croft run, describe, preview, rename, delete, restore), or a glob
  where a command takes exact names (--rebuild, delete, restore);
- flags that do not fit, such as --from on a transform (BACKFILL_UNSUPPORTED says more), or --rebuild
  without asset names;
- a value that does not parse: --from, --follow, --timeout, --rows, --limit, --for, --at;
- a command that cannot run in this state: a second croft serve for one project, a rename while another is
  unfinished, croft wait for a run id that does not exist;
- environment settings croft reads that are malformed (CROFT_NOW, CROFT_URL, CROFT_JOB_LABEL).

Nothing was changed.

What to do: read the message and the hint; the hint gives the command's usage or the corrected command, and the
fix, when there is one, is the command to run instead. croft help <command> lists a command's flags, and
croft docs --list the docs pages. Correct the command line and run it again; never retry the same line unchanged.
A corrected --rebuild, delete or restore still asks for a confirmation: ask the user before you confirm it.
