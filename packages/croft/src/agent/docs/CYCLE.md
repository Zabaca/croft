# CYCLE: assets read each other in a circle

croft builds assets in dependency order, each after the assets it reads. When a reads b and b reads a, directly
or through others, there is no such order. The message names the path and the files:

    assets read each other in a cycle: a → b → a (assets/a.sql → assets/b.sql → assets/a.sql)

The assets in the cycle, and every asset after them, are left out of the run order; the others still run.

What to do: remove one of the reads the hint lists. An asset reads:
- the tables its SQL names (in FROM, JOIN and subqueries);
- for a TypeScript transform, the assets in its inputs;
- the tables named in a check's subquery (-- check: id IN (SELECT id FROM other)), which count for the order.

Often the way out is a third asset: move what both need into a new asset that each of them reads. An asset that
reads its own table is a cycle of one: remove that read.
