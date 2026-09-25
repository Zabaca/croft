# JSON_KIND_CHANGED: a JSON column now also holds another kind of value (warning)

Nested data is stored in JSON columns (croft docs ingest). croft records which kinds each JSON column has held:
objects, arrays, strings, numbers, booleans. JSON_KIND_CHANGED means new values of another kind arrived: a user
field that was always an object now also holds strings, or a list that is now sometimes an object. details: column,
before, added.

The write went ahead and every value is kept. But SQL written for the old kind reads the new values wrong:
user->>'login' returns NULL on a value that is not an object, and a query over an array returns nothing for an
object. croft status and croft context show it among the asset's drift warnings for 7 days.

What to do: find the new values (croft query "select user from <asset> where json_type(user) <> 'OBJECT' limit 5"
with the column and kind the message names), then either normalize them in rows() so the column keeps one kind,
or update the SQL that reads the column (croft describe <asset> lists readBy) to handle both.
