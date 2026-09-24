# CATALOG_PREFIX: a table named through a database or schema prefix

Every table of a croft project lives in the warehouse's main schema, and an SQL asset reads them by their plain
names: FROM orders. A prefix such as warehouse.main.orders, memory.orders or other.orders either names a
project table in a way croft cannot track as an input, or reaches outside the project's tables. main.orders is
accepted: it is the same as orders.

What to do:
- A table of this project: drop the prefix (the fix does it), FROM orders.
- Anything else: an SQL asset reads only the project's tables. Bring outside data in with an ingest (croft docs
  ingest), then read its table by name.
