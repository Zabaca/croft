// Building blocks for task verifiers. A verifier reads the project through `croft query` (never the DuckDB file
// directly) and compares with numbers computed from the fixture's own data.
//
// Two views of a transform are checked:
// - warehouse: the table the agent left built;
// - code: what the project's SQL computes now, run as one query in which each SQL asset of the chain becomes a
//   CTE over the raw ingest tables. It tells "fixed the SQL but never ran it" from "did not fix it", and it is
//   what the self-test can check before this croft builds transforms.
import type { Fixture, Verdict, VerifyCheck } from "./harness.ts";

/** Run one check: ok unless it throws; the error message is the detail. */
export async function check(name: string, kind: VerifyCheck["kind"], fn: () => Promise<string | void> | string | void): Promise<VerifyCheck> {
  try {
    const detail = await fn();
    return { name, kind, ok: true, detail: detail ?? "" };
  } catch (e) {
    return { name, kind, ok: false, detail: (e as Error).message };
  }
}

export function verdict(checks: VerifyCheck[]): Verdict {
  return { pass: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/**
 * An SQL asset's text without a trailing `;` (and the comments and blank space after it), so it can sit inside
 * parentheses. Strings, quoted names and comments are skipped while looking for it.
 */
export function sqlBody(text: string): string {
  let lastCode = -1; // index of the last character outside comments and whitespace
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        const k = text.indexOf(c, j);
        if (k < 0) {
          j = text.length;
          break;
        }
        if (text[k + 1] === c) {
          j = k + 2;
          continue;
        }
        j = k + 1;
        break;
      }
      lastCode = j - 1;
      i = j;
    } else {
      if (!/\s/.test(c)) lastCode = i;
      i++;
    }
  }
  if (lastCode >= 0 && text[lastCode] === ";") return sqlBody(text.slice(0, lastCode));
  return text;
}

/**
 * One SELECT that computes `select` over the project's SQL assets as they are now: `WITH a AS (<a's SQL>), b AS
 * (<b's SQL>) <select>`. List the assets in dependency order; each reads the raw tables and the CTEs before it.
 */
export function composeSql(f: Fixture, assets: readonly string[], select: string): string {
  const ctes = assets.map((name) => {
    const rel = `assets/${name}.sql`;
    if (!f.exists(rel)) throw new Error(`${rel} is missing`);
    return `"${name}" AS (\n${sqlBody(f.read(rel))}\n)`;
  });
  return `WITH ${ctes.join(",\n")}\n${select}`;
}

/** A number of cents from a dollar value croft returned (DOUBLE, DECIMAL as number or text). */
export function cents(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v));
  if (!Number.isFinite(n)) throw new Error(`not a number: ${JSON.stringify(v)}`);
  return Math.round(n * 100);
}

/** Throws unless every name is among the columns. */
export function needColumns(table: string, columns: readonly string[], names: readonly string[]): void {
  const missing = names.filter((n) => !columns.includes(n));
  if (missing.length) throw new Error(`${table} has no column ${missing.join(", ")} (columns: ${columns.join(", ")})`);
}

/** Throws unless the rows are equal, in order; the message names the first difference. */
export function sameRows<T>(label: string, actual: readonly T[], expected: readonly T[]): string {
  const a = actual.map((r) => JSON.stringify(r));
  const e = expected.map((r) => JSON.stringify(r));
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      throw new Error(`${label}: row ${i + 1} is ${a[i] ?? "missing"}, expected ${e[i] ?? "no row"} (${actual.length} rows, expected ${expected.length})`);
    }
  }
  return `${actual.length} rows as expected`;
}

/** Throws unless every listed file has the text it had when the session started. */
export function unchanged(f: Fixture, files: readonly string[]): string {
  const changed = files.filter((rel) => !f.exists(rel) || f.read(rel) !== f.originals.get(rel));
  if (changed.length) throw new Error(`changed: ${changed.join(", ")}`);
  return `${files.length} files unchanged`;
}
