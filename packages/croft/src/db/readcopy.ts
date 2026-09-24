// The opt-in read copy for GUIs (DESIGN.md §5, `readCopy` in croft.json): warehouse.read.duckdb, refreshed
// after each run that wrote, by a child process that CHECKPOINTs and clones the file (`cp -c` on APFS,
// `cp --reflink=auto` elsewhere) and renames it into place.

/** Called by the runner after a run that committed writes. A no-op unless readCopy is on. Never throws. */
export async function refreshReadCopy(_root: string): Promise<void> {
  // Built in phase 3 wave 2 (RC); a no-op until then.
}
