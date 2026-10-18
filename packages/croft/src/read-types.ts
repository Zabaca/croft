// Types for @zabaca/croft/read. Source of truth: DESIGN.md §5 and §10.
export interface ReadOptions {
  project?: string;                          // project root; else CROFT_PROJECT, else walk up from cwd
  url?: string;                              // croft serve URL; else CROFT_URL, else .croft/serve.json, else direct
  token?: string;                            // else CROFT_SERVE_TOKEN, else the local serve.json
  limit?: number;                            // max rows; default 10,000; more is QUERY_TOO_MANY_ROWS, never truncation
  timeoutMs?: number;
}

declare global {
  /**
   * Each croft table's rows, by table name, as query() returns them. Empty here: a project's
   * .croft/types/index.d.ts fills it in after a run or preview, once the app's tsconfig.json includes it.
   * Global rather than a module's, so it reaches an app whose copy of croft is not the project's.
   */
  interface CroftTables {}
}

/** The rows query<"x">() returns: x's generated type once croft has written it, plain rows until then. */
export type TableRow<N extends string> = N extends keyof CroftTables ? CroftTables[N] : Record<string, unknown>;
