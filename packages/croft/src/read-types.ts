// Types for @zabaca/croft/read. Source of truth: DESIGN.md §5 and §10.
export interface ReadOptions {
  project?: string;                          // project root; else CROFT_PROJECT, else walk up from cwd
  url?: string;                              // croft serve URL; else CROFT_URL, else .croft/serve.json, else direct
  token?: string;                            // else CROFT_SERVE_TOKEN, else the local serve.json
  limit?: number;                            // max rows; default 10,000; more is QUERY_TOO_MANY_ROWS, never truncation
  timeoutMs?: number;
}
