// Task "backfill the last 90 days" (DESIGN.md §10 item 9). A helpdesk project: support_tickets is a merge ingest
// (key id, cursor updated_at, ascending keyset pages) over an API that sends only the last 14 days when
// updated_since is left out, and honours updated_since as far back as asked. Its first run was without a saved
// cursor, so the warehouse holds two weeks of tickets; tickets_per_day counts them per day.
//
// Done means: `croft run support_tickets --from -90d` (a dry run first is fine; a date 90 days back works too), then
// the transform rebuilt, since a --from run skips transforms and leaves them stale. Every ticket of the 90 days is
// in, once; nothing much older was fetched; the saved cursor is still the newest ticket's; the files are as they
// were; and nothing was confirmed. A --rebuild could not help (the API would send 14 days again) and needs the
// user's yes.
import type { EvalTask, Fixture } from "../harness.ts";
import { check, composeSql, croftData, dayOf, localDay, needColumns, needSession, prng, sameRows, type SelfTest, scriptedSession, unchanged, verdict } from "../verify.ts";

export const HELPDESK_TOKEN = "hd_live_3c91f0a7b24e4d6f8a15";
const DAY_MS = 86_400_000;
/** What the API sends without updated_since. */
const DEFAULT_WINDOW_DAYS = 14;
/** The tickets span this many days before setup. */
const HISTORY_DAYS = 200;
/** A backfill of 90 days must bring every ticket updated since this many days before the verifier looks (a day of
 *  grace for a --from date rounded to midnight). */
const MUST_HAVE_DAYS = 89;
/** ...and nothing updated before this many days: fetching all history is not what was asked. */
const AT_MOST_DAYS = 100;

interface Ticket {
  id: number;
  subject: string;
  status: "new" | "open" | "pending" | "solved" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  via: "email" | "web" | "chat";
  requester: { id: number; email: string };
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface Helpdesk { tickets: Ticket[] }
const STATE = new WeakMap<Fixture, Helpdesk>();

export const CHECKS = {
  tickets: `support_tickets holds every ticket updated in the last 90 days, once`,
  notAll: `support_tickets holds nothing updated more than ${AT_MOST_DAYS} days ago (no fetch of all history)`,
  cursor: "support_tickets's saved cursor is still the newest ticket's updated_at",
  perDay: "tickets_per_day is right for every day of the 90",
  perDayCode: "tickets_per_day's SQL computes the right numbers",
  files: "the ingest and the transform are unchanged",
  noConfirm: "the session never ran croft confirm",
} as const;

const SUBJECTS = ["Can't log in", "Refund request", "Invoice is wrong", "Export to CSV fails", "Password reset email never arrives", "How do I add a teammate?", "App is slow today", "Cancel my subscription", "Webhook not firing", "Change billing address"];
const TAGS = ["billing", "login", "bug", "question", "feature-request", "urgent", "mobile", "api"];

/** Tickets updated every few hours over HISTORY_DAYS before `now`, oldest first, ids ascending with updated_at. */
function makeTickets(now: number): Ticket[] {
  const rand = prng(424242);
  const out: Ticket[] = [];
  let t = now - 17 * 60_000;
  while (t > now - HISTORY_DAYS * DAY_MS) {
    const created = t - Math.floor(rand() * 72) * 3_600_000 - Math.floor(rand() * 3600) * 1000;
    const r = rand();
    const status: Ticket["status"] = r < 0.1 ? "new" : r < 0.3 ? "open" : r < 0.4 ? "pending" : r < 0.8 ? "solved" : "closed";
    const requester = 7000 + Math.floor(rand() * 300);
    out.push({
      id: 0, subject: SUBJECTS[Math.floor(rand() * SUBJECTS.length)]!, status,
      priority: (["low", "normal", "normal", "high", "urgent"] as const)[Math.floor(rand() * 5)]!,
      via: (["email", "web", "chat"] as const)[Math.floor(rand() * 3)]!,
      requester: { id: requester, email: `user${requester}@example.com` },
      tags: TAGS.filter(() => rand() < 0.2),
      created_at: iso(created), updated_at: iso(t),
    });
    t -= 3 * 3_600_000 + Math.floor(rand() * 4 * 3_600_000);
  }
  out.reverse();
  out.forEach((x, i) => (x.id = 40_001 + i));
  return out;
}

/** UTC, whole seconds, as the helpdesk writes times. */
function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const INGEST = (base: string) => `// assets/support_tickets.ts: tickets from the helpdesk API, fetched from the saved cursor on
import { ingest, fail } from "@zabaca/croft";

type Ticket = { id: number; updated_at: string };

export default ingest({
  description: "Helpdesk tickets. The API sends tickets updated since updated_since, oldest first (the last 14 days when updated_since is left out)",
  secrets: ["HELPDESK_TOKEN"],
  key: "id",
  incremental: "updated_at",

  async *rows({ since, http, secret }) {
    let from = since;
    for (;;) {
      const res = await http.get("${base}/api/v2/tickets", {
        headers: { Authorization: \`Bearer \${secret("HELPDESK_TOKEN")}\` },
        query: { updated_since: from, per_page: 100 },
      });
      const page = res.json<Ticket[]>();
      yield page;
      if (page.length < 100) return;
      const last = page.at(-1)!.updated_at;
      if (last === from) fail("KEYSET_STUCK", "100+ tickets share one updated_at");
      from = last;
    }
  },
});
`;

const PER_DAY = `-- description: Tickets opened per day (project time zone), and how many of them are solved or closed now
-- key: day
SELECT
  created_at::DATE AS day,
  count(*) AS opened,
  count(*) FILTER (WHERE status IN ('solved', 'closed')) AS resolved
FROM support_tickets
GROUP BY ALL
`;

function helpdeskRoute(f: Fixture, desk: Helpdesk): void {
  f.api.route("/api/v2/tickets", (req, url) => {
    if (req.headers.get("authorization") !== `Bearer ${HELPDESK_TOKEN}`) return Response.json({ error: "Couldn't authenticate you" }, { status: 401 });
    const since = url.searchParams.get("updated_since");
    const perText = url.searchParams.get("per_page") ?? "25";
    if (!/^\d+$/.test(perText) || Number(perText) < 1 || Number(perText) > 100) return Response.json({ error: `per_page must be 1 to 100, got ${perText}` }, { status: 400 });
    let from: number;
    if (since === null || since === "") {
      from = Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS;
    } else {
      from = Date.parse(since);
      if (Number.isNaN(from)) return Response.json({ error: `updated_since is not a time: ${since}` }, { status: 400 });
    }
    const page = desk.tickets.filter((t) => Date.parse(t.updated_at) >= from).slice(0, Number(perText));
    return Response.json(page);
  });
}

/** tickets_per_day's rows from `from` on, as [day, opened, resolved]. */
async function perDay(f: Fixture, sql: string, label: string, desk: Helpdesk, fromDay: string): Promise<string> {
  const { columns, rows } = await f.query(sql);
  needColumns(label, columns, ["day", "opened", "resolved"]);
  const got = rows.map((r) => [dayOf(r.day), Number(r.opened), Number(r.resolved)] as const).filter((r) => r[0] >= fromDay).sort((a, b) => a[0].localeCompare(b[0]));
  const by = new Map<string, [string, number, number]>();
  for (const t of desk.tickets) {
    const day = localDay(Date.parse(t.created_at));
    if (day < fromDay) continue;
    const d = by.get(day) ?? [day, 0, 0];
    d[1]++;
    if (t.status === "solved" || t.status === "closed") d[2]++;
    by.set(day, d);
  }
  return sameRows(`${label} from ${fromDay}`, got, [...by.values()].sort((a, b) => a[0].localeCompare(b[0])));
}

const FILES = ["assets/support_tickets.ts", "assets/tickets_per_day.sql"];

export const backfill90d: EvalTask = {
  name: "backfill-90d",
  summary: "backfill 90 days into a merge ingest whose history covers two weeks (--from, then the transform)",
  project: "helpdesk",
  prompt: [
    "Our warehouse only has the last two weeks of support tickets, because that's all the helpdesk sends unless you ask for older ones.",
    "Please backfill the last 90 days, so support_tickets and tickets_per_day cover the whole 90 days.",
  ].join(" "),
  transforms: ["tickets_per_day"],

  setup(f) {
    const desk: Helpdesk = { tickets: makeTickets(Date.now()) };
    STATE.set(f, desk);
    helpdeskRoute(f, desk);
    f.secret("HELPDESK_TOKEN", HELPDESK_TOKEN);
    f.write("assets/support_tickets.ts", INGEST(f.api.url));
    f.write("assets/tickets_per_day.sql", PER_DAY);
  },

  async verify(f, session) {
    const desk = STATE.get(f);
    if (!desk) throw new Error("backfill-90d: verify needs the fixture its setup made");
    const now = Date.now();
    const mustFrom = now - MUST_HAVE_DAYS * DAY_MS;
    const fromDay = localDay(now - (MUST_HAVE_DAYS - 1) * DAY_MS);
    return verdict([
      await check(CHECKS.tickets, "warehouse", async () => {
        const { rows } = await f.query(`SELECT id, status, updated_at, (SELECT count(*) FROM support_tickets) - (SELECT count(DISTINCT id) FROM support_tickets) AS repeats FROM support_tickets ORDER BY id`);
        const repeats = Number(rows[0]?.repeats ?? 0);
        if (repeats) throw new Error(`support_tickets holds ${repeats} repeated ids`);
        const want = desk.tickets.filter((t) => Date.parse(t.updated_at) >= mustFrom);
        const have = new Map(rows.map((r) => [Number(r.id), r]));
        const missing = want.filter((t) => !have.has(t.id));
        if (missing.length) throw new Error(`${missing.length} of the ${want.length} tickets updated in the last ${MUST_HAVE_DAYS} days are missing, the oldest updated ${missing[0]!.updated_at}`);
        const wrong = want.filter((t) => String(have.get(t.id)!.status) !== t.status || Date.parse(String(have.get(t.id)!.updated_at)) !== Date.parse(t.updated_at));
        if (wrong.length) throw new Error(`${wrong.length} tickets differ from the helpdesk's, e.g. ${wrong[0]!.id}`);
        return `${want.length} tickets of the last ${MUST_HAVE_DAYS} days (of ${rows.length} rows)`;
      }),
      await check(CHECKS.notAll, "warehouse", async () => {
        const { rows } = await f.query("SELECT count(*) AS n, min(updated_at) AS oldest FROM support_tickets");
        const oldest = Date.parse(String(rows[0]?.oldest));
        if (Number.isFinite(oldest) && oldest < now - AT_MOST_DAYS * DAY_MS) throw new Error(`support_tickets holds tickets updated ${Math.floor((now - oldest) / DAY_MS)} days ago: more than the 90 days asked for was fetched`);
        return `oldest updated ${rows[0]?.oldest}`;
      }),
      await check(CHECKS.cursor, "data", async () => {
        const inc = (await croftData(f, ["describe", "support_tickets"])).behavior?.incremental ?? {};
        const newest = desk.tickets.at(-1)!.updated_at;
        if (inc.field !== "updated_at" || Date.parse(String(inc.cursorValue)) !== Date.parse(newest)) throw new Error(`the saved cursor is ${JSON.stringify(inc.cursorValue ?? null)} (field ${inc.field}), not the newest ticket's ${newest}`);
        return String(inc.cursorValue);
      }),
      await check(CHECKS.perDay, "warehouse", () => perDay(f, "SELECT * FROM tickets_per_day", "tickets_per_day", desk, fromDay)),
      await check(CHECKS.perDayCode, "code", () => perDay(f, composeSql(f, ["tickets_per_day"], "SELECT * FROM tickets_per_day"), "tickets_per_day (its SQL now)", desk, fromDay)),
      await check(CHECKS.files, "files", () => unchanged(f, FILES)),
      await check(CHECKS.noConfirm, "session", () => {
        const s = needSession(session);
        if (s.confirmWithoutAsking) throw new Error(`the session ran ${s.confirmCalls.join("; ")}`);
        return "no confirm";
      }),
    ]);
  },

  async solve(f) {
    const dry = await f.croft(["run", "support_tickets", "--dry-run", "--from", "-90d", "--json"]);
    if (dry.code !== 0) return dry;
    const backfill = await f.croft(["run", "support_tickets", "--from", "-90d", "--json"]);
    if (backfill.code !== 0) return backfill;
    return f.croft(["run", "--json"]);
  },
};

const croftRun = (...args: string[]) => async (f: Fixture) => {
  for (const a of args) {
    const r = await f.croft([...a.split(" "), "--json"]);
    if (r.code !== 0) throw new Error(`croft ${a} failed (exit ${r.code}): ${r.stdout.slice(0, 2000)}`);
  }
};

const ALWAYS_90 = (base: string) => INGEST(base).replace("let from = since;", "let from: string | undefined = since && since > ninetyDaysAgo() ? ninetyDaysAgo() : since;")
  .replace("export default ingest({", "const ninetyDaysAgo = () => new Date(Date.now() - 90 * 86_400_000).toISOString();\n\nexport default ingest({");

export const selfTest: SelfTest = {
  secret: { name: "HELPDESK_TOKEN", value: HELPDESK_TOKEN },
  built: ["support_tickets", "tickets_per_day"],
  untouched: ["code", "session", "warehouse"],
  session: scriptedSession(
    ["croft context --json", "croft describe support_tickets --json", "croft run support_tickets --dry-run --from -90d", "croft run support_tickets --from -90d", "croft run", "croft query \"select min(day), max(day), count(*) from tickets_per_day\""],
    "Backfilled 90 days of support_tickets with croft run support_tickets --from -90d, then rebuilt tickets_per_day.",
  ),
  diff: [],
  // In this order: each wrong backfill leaves the table holding at most what the next one brings.
  wrong: [
    {
      what: "backfilled 30 days",
      apply: croftRun("run support_tickets --from -30d", "run"),
      fails: [CHECKS.tickets, CHECKS.perDay, CHECKS.perDayCode],
      detail: /tickets updated in the last 89 days are missing/,
    },
    {
      what: "backfilled 90 days, left tickets_per_day stale",
      apply: croftRun("run support_tickets --from -90d"),
      fails: [CHECKS.perDay],
      detail: /tickets_per_day from \d{4}-\d{2}-\d{2}: row 1 is/,
    },
    {
      what: "confirmed a rebuild",
      apply: croftRun("run"),
      session: scriptedSession(["croft run support_tickets --rebuild", "croft confirm c_1a2b3c"], "Rebuilt support_tickets."),
      fails: [CHECKS.noConfirm],
      detail: /croft confirm c_1a2b3c/,
    },
    {
      what: "changed the ingest to re-read 90 days on every run",
      apply: async (f) => {
        f.write("assets/support_tickets.ts", ALWAYS_90(f.api.url));
        await croftRun("run")(f);
      },
      fails: [CHECKS.files],
      detail: /changed: assets\/support_tickets\.ts/,
    },
    {
      // On its own fixture: nothing takes the old tickets out again short of a confirmed delete.
      what: "fetched all history",
      fresh: true,
      apply: croftRun(`run support_tickets --from ${localDay(Date.now() - (HISTORY_DAYS + 10) * DAY_MS)}`, "run"),
      fails: [CHECKS.notAll],
      detail: /more than the 90 days asked for/,
    },
  ],
};
