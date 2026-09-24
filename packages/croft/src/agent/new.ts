// The templates `croft new` writes (DESIGN.md §3, §4.1): commented, working assets that pass croft validate as
// written. Phase 5 contract stub: its builder (NW) replaces this.
import { phaseStub } from "../core/phase.ts";

export type NewKind = "api" | "file" | "sql" | "transform";
export type Pagination = "keyset" | "cursor" | "link" | "page";

export interface Template {
  kind: NewKind;
  pagination?: Pagination;
  /** Relative to the project root: assets/<name>.ts or .sql. */
  path: string;
  content: string;
  /** One line: what it is and what to edit. */
  summary: string;
  /** Secrets the template reads (ctx.secret), for the next step. */
  secrets: string[];
}

/** The kinds and styles, for `croft new --list`. */
export const TEMPLATE_KINDS: readonly { kind: NewKind; pagination?: Pagination; description: string }[] = [];

export function templateFor(kind: NewKind, name: string, o: { pagination?: Pagination } = {}): Template {
  return phaseStub(`templateFor(${kind}, ${name}, ${o.pagination ?? ""})`);
}
