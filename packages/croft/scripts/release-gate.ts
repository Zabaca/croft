// publish-npm.yml: refuses a release unless ci.yml ran croft's whole suite and passed on main at the commit the tag names (DESIGN.md D196). A
// release publishes what main already tested, so the release does not run the suite again. This asks GitHub for ci.yml's runs at that commit
// (read-only: the job's own token with `actions: read`) and waits, within a limit, for one still running; no run, or only failed, cancelled or
// partly skipped ones, stops the release.
//
// Which runs count: a push to main, or a manual run (workflow_dispatch) on main, at exactly that commit. A tag run (ci.yml does not run on
// croft-v* tags), a pull request's run and the daily run do not. And a run counts only if every job of it succeeded: a push whose change
// detector found only the site, docs or infrastructure skips every croft job and still ends `success`, so a docs-only commit on top of a croft
// commit whose own run failed or was cancelled (main cancels a run a newer push supersedes) would otherwise release untested code. A manual
// run always runs everything, which is the way to get a full run at such a commit.
//
//   bun scripts/release-gate.ts      reads GITHUB_REPOSITORY, GITHUB_SHA and GH_TOKEN; exits 0 to go on and 1 to stop
export interface CiRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
}
export interface CiJob {
  name: string;
  conclusion: string | null;
}
export interface Verdict {
  state: "pass" | "wait" | "fail";
  why: string;
}

/** How long a run may be missing before that is an answer: GitHub makes the run when the push lands, so a minute or two is slack. */
export const GRACE_SECONDS = 150;
/** How long to wait for a run still going: main's push run takes about 25 minutes, and a tag is often pushed with its merge. */
export const LIMIT_SECONDS = 45 * 60;
/** One kind of croft job a full run has: the jobs of ci.yml that share a name shape, and how many of them there are. */
export interface JobKind {
  label: string;
  /** The name a job of this kind has once its matrix is expanded. Anchored, so that no kind's jobs match another's: "shard" or "smoke" alone would also match the after-merge, log, lake, Alpine and Windows jobs. */
  name: RegExp;
  count: number;
}
/** Every kind of croft job a full run has, with the jobs of each counted (tests/workflows.test.ts expands ci.yml's matrices and checks that its jobs are exactly these). A skipped matrix job keeps its unexpanded name, so it matches none of them, and a run missing a shard, a platform or a whole job is short of its count. */
export const JOB_KINDS: JobKind[] = [
  { label: "the suite's shards", name: /^ubuntu-24\.04 · bun 1\.3\.14 · shard \d+\/7$/, count: 7 },
  { label: "the after-merge platforms", name: /^after a merge · ubuntu-24\.04(?:-arm)? · bun (?:1\.3\.14|latest) · shard \d+\/4$/, count: 12 },
  { label: "the log run", name: /^ubuntu-24\.04 · bun 1\.3\.14 · bookkeeping as a log · shard \d+\/2$/, count: 2 },
  { label: "the journeys on a local lake", name: /^ubuntu-24\.04 · bun 1\.3\.14 · journeys on a local lake · shard \d+\/4$/, count: 4 },
  { label: "the journeys on a Postgres lake", name: /^ubuntu-24\.04 · bun 1\.3\.14 · journeys on a Postgres lake · shard \d+\/5$/, count: 5 },
  { label: "the platform smokes", name: /^ubuntu-24\.04(?:-arm)? · bun (?:1\.3\.14|latest) · smoke$/, count: 3 },
  { label: "the Alpine smoke", name: /^alpine smoke$/, count: 1 },
  { label: "the Windows smoke", name: /^windows smoke$/, count: 1 },
];

/** Whether the jobs of a run are a full, passing run of croft's suite: every job a success (a skipped one is not), and each kind of croft job there as many times as ci.yml has it. */
export function fullRun(jobs: CiJob[]): { ok: true } | { ok: false; why: string } {
  const bad = jobs.filter((j) => j.conclusion !== "success");
  if (bad.length > 0) return { ok: false, why: `${bad.length} of its ${jobs.length} jobs were not a success (${[...new Set(bad.map((j) => j.conclusion))].join(", ")}; for example "${bad[0]!.name}")` };
  const short = JOB_KINDS.map((k) => ({ k, n: jobs.filter((j) => k.name.test(j.name)).length })).filter(({ k, n }) => n !== k.count);
  if (short.length > 0) return { ok: false, why: `it has the wrong number of jobs for: ${short.map(({ k, n }) => `${k.label} (${n} of ${k.count})`).join(", ")}` };
  return { ok: true };
}

/** What the runs of ci.yml say about `sha`. `jobs` holds the jobs of each completed successful run, by run id. `waited` is the seconds since the first look. */
export function judge(runs: CiRun[], jobs: Record<number, CiJob[]>, sha: string, waited: number): Verdict {
  const here = runs.filter((r) => (r.event === "push" || r.event === "workflow_dispatch") && r.head_branch === "main" && r.head_sha === sha);
  const notFull: string[] = [];
  for (const r of here.filter((x) => x.status === "completed" && x.conclusion === "success")) {
    const full = fullRun(jobs[r.id] ?? []);
    if (full.ok) return { state: "pass", why: `ci.yml passed in full on main at ${sha} (${r.event}): ${r.html_url}` };
    notFull.push(`${r.event} run ${r.html_url}: ${full.why}`);
  }
  const running = here.find((r) => r.status !== "completed");
  if (running) return { state: "wait", why: `ci.yml is still running on main at ${sha} (${running.event}, ${running.status}): ${running.html_url}` };
  if (here.length === 0) {
    return waited < GRACE_SECONDS
      ? { state: "wait", why: `no ci.yml run on main at ${sha} yet` }
      : { state: "fail", why: `no ci.yml run on a push to main at ${sha}: tag a commit that main's CI ran on (the tip of a push to main), or run \`gh workflow run ci.yml --ref main\` while main's tip is ${sha}` };
  }
  if (notFull.length > 0) {
    return { state: "fail", why: `ci.yml ended success on main at ${sha} but did not run croft's whole suite (${notFull.join("; ")}). Get a full run at this commit: while main's tip is ${sha}, run \`gh workflow run ci.yml --ref main\` (a manual run always runs everything), wait for it, then re-run this workflow with \`gh workflow run publish-npm.yml --ref ${process.env.GITHUB_REF_NAME ?? "croft-v<version>"}\`` };
  }
  const ended = here.map((r) => `${r.event} ${r.conclusion} ${r.html_url}`).join(", ");
  return { state: "fail", why: `ci.yml did not pass on main at ${sha} (${ended}); fix it or re-run it on main, then re-run this workflow from the tag's ref` };
}

const API = "https://api.github.com";
async function get<T>(path: string, token: string): Promise<T | "retry"> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  if (res.status >= 500) return "retry";
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Every run of ci.yml on main at `sha` (push and manual runs, and the daily run, which `judge` leaves out), and the jobs of the successful ones. */
async function look(repo: string, sha: string, token: string): Promise<{ runs: CiRun[]; jobs: Record<number, CiJob[]> } | "retry"> {
  const listed = await get<{ workflow_runs: CiRun[] }>(`/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&per_page=50`, token);
  if (listed === "retry") return "retry";
  const jobs: Record<number, CiJob[]> = {};
  for (const r of listed.workflow_runs) {
    if (!((r.event === "push" || r.event === "workflow_dispatch") && r.status === "completed" && r.conclusion === "success")) continue;
    const got = await get<{ jobs: CiJob[] }>(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`, token);
    if (got === "retry") return "retry";
    jobs[r.id] = got.jobs;
  }
  return { runs: listed.workflow_runs, jobs };
}

if (import.meta.main) {
  const [repo, sha, token] = [process.env.GITHUB_REPOSITORY, process.env.GITHUB_SHA, process.env.GH_TOKEN];
  if (!repo || !sha || !token) {
    console.error("release-gate: GITHUB_REPOSITORY, GITHUB_SHA and GH_TOKEN are needed");
    process.exit(2);
  }
  const started = Date.now();
  for (;;) {
    const waited = (Date.now() - started) / 1000;
    const seen = await look(repo, sha, token);
    const verdict: Verdict = seen === "retry" ? { state: "wait", why: "GitHub's API is not answering" } : judge(seen.runs, seen.jobs, sha, waited);
    console.log(verdict.why);
    if (verdict.state === "pass") process.exit(0);
    if (verdict.state === "fail") {
      console.error(`::error::${verdict.why}`);
      process.exit(1);
    }
    if (waited > LIMIT_SECONDS) {
      console.error(`::error::ci.yml was not done on main at ${sha} after ${LIMIT_SECONDS / 60} minutes; re-run this workflow from the tag's ref when it is`);
      process.exit(1);
    }
    await Bun.sleep(30_000);
  }
}
