# CONFIRMATION_STALE: the token no longer matches what it would do

croft confirm <token> carries out exactly what the user saw, or nothing. Before it acts it checks the token
against now, and refuses (exit 5) when:
- the token expired (after 15 minutes), was already used, or a newer token for the same action replaced it;
- the impact changed since it was shown: the table was written meanwhile, more or fewer rows would be deleted, a
  key conversion would now remove another number of duplicates.

details.reason says which; details.impact is the impact now and details.previousImpact the one the user said yes to.

Nothing was changed. (A delete --where whose rows changed at the last moment may leave an extra copy of them in
the trash, listed as not deleted.)

What to do: run the original command again (the fix names it) to get a new token and the current impact. Show the
user the new impact, ask the user again, and run croft confirm <new token> only after their explicit yes. Never
reuse an old yes for a new impact.
