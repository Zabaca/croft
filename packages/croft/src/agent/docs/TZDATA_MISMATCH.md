# TZDATA_MISMATCH: Bun and DuckDB disagree about the project's time zone (warning)

croft works in the project's time zone ("timezone" in croft.json) in two places: Bun formats timestamps in JSON
output, and DuckDB computes ::DATE and date_trunc in SQL. Each carries its own time zone database. croft doctor
checks that they agree for the project's zone over the coming years, and warns when:
- DuckDB does not know the zone name at all (an alias Bun accepts, such as US/Pacific); or
- the two disagree about an offset at some instants (a daylight-saving rule changed and one of them is older).
details.first and details.last show the instants.

Nothing is blocked, but near those instants a row's JSON timestamp and its ::DATE can fall on different days.

What to do:
- An unknown name: set "timezone" in croft.json to the canonical IANA name (America/Los_Angeles, Europe/Berlin).
- Disagreeing data: ask the user to upgrade Bun (bun upgrade) and croft, so both carry a current release. Until
  they agree, take days from SQL (::DATE), not from the JSON timestamps.
Then croft doctor again.
