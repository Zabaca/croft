# VOLATILE_SQL: an SQL asset uses a value that changes on every run (warning)

now(), current_date, current_timestamp, random(), gen_random_uuid() and similar functions give a new value each
time they run. An SQL asset is rebuilt only when an input or its SQL changes, so its table keeps the values of
its last rebuild: an "age in days" computed from current_date is wrong from the next day on, until something
else causes a rebuild.

What to do:
- Compute such columns when the table is read instead, in croft query or in the app's query:
  croft query "select *, current_date - created_at::DATE AS age_days from open_issues".
- Keep it if a build-time value is what you want (a "built at" column); the warning then stays as a reminder.
