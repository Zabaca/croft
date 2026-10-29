# LAMBDA_ARROW: a lambda written with an arrow

DuckDB 2.0 no longer reads lambdas written with an arrow, such as list_transform(tags, t -> upper(t)). It
writes them with the lambda keyword instead: list_transform(tags, lambda t: upper(t)). croft runs DuckDB 2.0,
so an SQL asset, a check or a query with an arrow lambda stops working until the lambda is rewritten.

What to do: rewrite each arrow lambda. The problem's fix has the exact edit (fix.replace: from, to):
    t -> upper(t)          becomes  lambda t: upper(t)
    (a, b) -> a + b        becomes  lambda a, b: a + b
    COLUMNS(c -> c LIKE 'a%')  becomes  COLUMNS(lambda c: c LIKE 'a%')
Then croft validate --json.

JSON's arrow is not a lambda and stays as it is: payload->'user' and payload->>'login' still work.
