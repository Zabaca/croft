// "Did you mean" suggestions for commands, options, config keys, doc topics and header keys.

/** Edit distance counting an adjacent transposition as one edit ("stauts" → "status" is 1). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prevPrev[j - 2]! + 1);
      cur.push(d);
    }
    prevPrev = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/** The closest candidate, or undefined when nothing is close enough to be a likely typo.
 *  Case differences are free; a unique prefix of 3+ characters also matches ("stat" → "status"). */
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  const want = input.toLowerCase();
  if (!want) return undefined;
  const exactCase = candidates.find((c) => c.toLowerCase() === want);
  if (exactCase) return exactCase;
  const limit = want.length <= 3 ? 1 : want.length <= 6 ? 2 : 3;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = editDistance(want, c.toLowerCase());
    if (d < bestDistance) { best = c; bestDistance = d; }
  }
  if (best !== undefined && bestDistance <= limit) return best;
  if (want.length >= 3) {
    const prefixed = candidates.filter((c) => c.toLowerCase().startsWith(want));
    if (prefixed.length === 1) return prefixed[0];
  }
  return undefined;
}
