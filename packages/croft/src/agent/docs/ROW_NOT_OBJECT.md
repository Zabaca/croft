# ROW_NOT_OBJECT: rows() or map() produced something that is not a row

A row is a plain object: { id: 1, name: "a" }. rows() yields rows, or arrays of rows (one array per page), or
returns an array of rows. ROW_NOT_OBJECT means croft got something else:
- rows() yielded a string, a number, null or a nested array (details.row is its position, details.type what it
  was); often an API's page object was yielded whole where its list was meant (yield page instead of yield
  page.data);
- rows() itself returned something that is neither an async generator nor an array;
- map() in a file ingest returned something that is not an object (return null drops a row on purpose; an arrow
  function with a block body needs a return);
- a JSON file holds values that are not objects (a JSON file is an array of objects, or one object per line).

Nothing was written for the step, and its cursor did not move.

What to do: fix the asset so every row is an object: yield page.items (whatever the API calls the list), wrap a
bare value ({ value: v }), or return the row from map(). croft logs <asset> --failed shows what the code logged,
and croft preview <asset> shows the rows it would write, without writing them.
