# UNSERIALIZABLE_VALUE: a row holds a value that cannot be stored as data

croft stores what rows() yields as JSON-like data: strings, numbers, booleans, null, bigint, Date, arrays and
plain objects. UNSERIALIZABLE_VALUE means a field (details.path, inside nested objects too) holds something else:
a Map or a Set, binary data (a Uint8Array or an ArrayBuffer), NaN or Infinity, a function, a Promise that was not
awaited, an invalid Date, an object that refers to itself, or text that is not valid Unicode.

Nothing was written for the step, and its cursor did not move.

What to do: convert the value in rows() (or map()), as the hint says:
- a Map: Object.fromEntries(map); a Set: [...set];
- binary data: a base64 string, or an array of numbers;
- NaN or Infinity: null, or a string. A number too big for a double (1e400) becomes Infinity under JSON.parse or
  fetch's res.json(); ctx.http's res.json() keeps its digits;
- a Promise: await it before yielding the row;
- a cycle: yield a copy without it; broken Unicode: s.toWellFormed().
Then croft preview <asset>, and croft run <asset>.
