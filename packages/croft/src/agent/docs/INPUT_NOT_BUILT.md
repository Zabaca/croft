# INPUT_NOT_BUILT: an input has never been built, so its readers' bind check waits (info)

croft validate checks every SQL asset against the columns of what it reads, without touching any data. It knows
an input's columns once the input has run (or been previewed). Until then it cannot tell whether the SQL's
column names are right, so it skips the bind check of the assets that read that input, and of the assets that
read those, and says so as info. This is not an error: nothing is known to be wrong.

    info  INPUT_NOT_BUILT  assets/daily_revenue.sql
          columns of stripe_charges are unknown until it has run or been previewed; bind check skipped

What to do: build or preview the input the problem names (its fix is the croft preview command; croft run
<input> works as well), then croft validate --json again. When the input's own file has errors, the message
names that file: fix those first.
