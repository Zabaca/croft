// How far above a promised latency a test lets the real one go before it calls it broken (DESIGN.md §10 "Test strategy", the rules against
// flaking). A latency the design promises (a writer gets the file within the grace and 100 ms; a deadline holds) is checked with room: the
// bound is the promise plus this, so it is far from the promise (a busy machine is late by a good part of a second, now and then) and
// still short of what the code does when it is wrong (waits for a query that runs for minutes, for a lock held for ever, for a grace
// that was meant to be skipped). A bound at the promise itself is a bound on the machine. It is the same on a laptop and on CI; a test
// whose wrong behavior comes sooner than this checks against that instead, and says so with a `timing-gap:` comment.
export const TIMING_GAP = 5_000;

/** How long the STUCK query (one `list_reduce` over 20M values, which an interrupt cannot stop) runs when nothing ends it: 6 s or more (12 s measured on a busy laptop). */
export const STUCK_MS = 6_000;
