# SCHEDULE_INVALID: an ingest's schedule croft cannot read

An ingest's `schedule:` is a phrase or a 5-field cron. croft turns it into a cron and fires it in the project time
zone (croft.json's timezone). These work, in any case:

- every 15 minutes (the minutes must divide 60: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60), every minute
- every hour, hourly, every hour at :15; every 6 hours (the hours must divide 24)
- daily at 06:00, every day at 9am, weekdays at 9am, weekends at 10:00
- every monday at 08:30 (any day; several: every monday and thursday at 9am; a range: mon-fri at 9am)
- monthly (the 1st at 00:00), monthly at 06:00
- a cron: minute hour day-of-month month day-of-week, such as 0 6 * * 1-5; or @hourly, @daily, @weekly, @monthly

Times are 06:00, 18:30, 9am, 6:30pm, noon or midnight. Without a time, a phrase fires at 00:00.

What to do: apply the fix when there is one. It replaces the schedule with the closest one croft reads
(evry hour → every hour, daily at 6 → daily at 06:00, every 7 minutes → every 6 minutes). Otherwise rewrite it
as one of the forms above. croft validate shows each schedule's cron and its next three fire times.

Cron cannot count seconds, or days, weeks and months that do not divide a month or a year: every 2 days has no
exact form (0 0 */2 * * fires on the 1st, 3rd, 5th, … of each month). Pick the nearest form above.

Daylight saving time never drops or doubles a fire. A time that a spring-forward skips (02:30 on the night the
clocks jump from 02:00 to 03:00) fires at 03:00. A time that a fall-back repeats (01:30) fires once, the first
time. Intervals (every 15 minutes, every hour) keep firing on real time through the repeated hour.
