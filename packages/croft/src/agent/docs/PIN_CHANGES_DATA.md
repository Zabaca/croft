# PIN_CHANGES_DATA: a changed type pin would rewrite values already stored

Pins (columns: { zip: "VARCHAR" }) are authoritative. A pin removed from the code unpins the column, and a pin that
differs from the column's stored type retypes the values already stored, not only new ones. Before it does, croft
counts the stored values the new type would change (try_cast(x AS new)::old IS DISTINCT FROM x; stored text is read
the way arriving text is, with the pin's format):

- none would change: the pin applies directly, and TYPE_WIDENED says the column was retyped exactly;
- some would: croft run stops before fetching anything and asks for a confirmation (impact.rows: the values that
  change). A run with nobody to ask fails with PIN_CHANGES_DATA, whose message shows samples ("02134" → 2134,
  "abc" → NULL).

croft preview <asset> applies the pin to its own copy without asking and reports PIN_CHANGES_DATA: details.samples
lists stored values that change and what each becomes, details.changed how many change. Retyping zip codes, ids
with leading zeros or phone numbers to numbers loses data. Ways forward:
- Keep the stored values: pin the old type again, or remove the pin (the problem's fix).
- Rewrite them: ask the user, showing the samples. If they agree, croft run <asset> asks for a confirmation (on a
  terminal Proceed? [y/N], elsewhere exit 5 with a token); after their explicit yes, croft confirm <token> moves the
  whole table to the trash first, then retypes the column as the samples showed. croft restore <asset> brings the
  old values back, after the user agrees to that too.

A pin must be a plain SQL type (BIGINT, DOUBLE, VARCHAR, DATE, TIMESTAMPTZ, JSON, DECIMAL(18,2), ...): anything else
is ASSET_INVALID.
