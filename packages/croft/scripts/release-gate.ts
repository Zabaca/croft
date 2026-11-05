// publish-npm.yml: refuses a release unless ci.yml passed on a push to main at the commit the tag names (DESIGN.md D196). A release publishes
// what main already tested, so the release does not run the suite again. This asks GitHub for ci.yml's runs at that commit (read-only: the
// job's own token with `actions: read`) and waits, within a limit, for one still running; no run, or only failed or cancelled ones, stops the
// release. A tag run (ci.yml does not run on croft-v* tags), a pull request's run and the daily run do not count: only a push to main does.
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
export interface Verdict {
  state: "pass" | "wait" | "fail";
  why: string;
}

/** How long a run may be missing before that is an answer: GitHub makes the run when the push lands, so a minute or two is slack. */
export const GRACE_SECONDS = 150;

/** What the runs of ci.yml say about `sha`. `waited` is the seconds since the first look. */
export function judge(runs: CiRun[], sha: string, waited: number): Verdict {
  const push = runs.filter((r) => r.event === "push" && r.head_branch === "main" && r.head_sha === sha);
  const passed = push.find((r) => r.status === "completed" && r.conclusion === "success");
  if (passed) return { state: "pass", why: `ci.yml passed on main at ${sha}: ${passed.html_url}` };
  const running = push.find((r) => r.status !== "completed");
  if (running) return { state: "wait", why: `ci.yml is still running on main at ${sha} (${running.status}): ${running.html_url}` };
  if (push.length === 0) {
    return waited < GRACE_SECONDS
      ? { state: "wait", why: `no ci.yml run on main at ${sha} yet` }
      : { state: "fail", why: `no ci.yml run on a push to main at ${sha}: tag a commit that main's CI ran on (the tip of a push to main)` };
  }
  const ended = push.map((r) => `${r.conclusion} ${r.html_url}`).join(", ");
  return { state: "fail", why: `ci.yml did not pass on main at ${sha} (${ended}); fix it or re-run it on main, then re-run this workflow from the tag's ref` };
}

async function runsAt(repo: string, sha: string, token: string): Promise<CiRun[] | "retry"> {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=30`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  if (res.status >= 500) return "retry";
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}: ${await res.text()}`);
  return ((await res.json()) as { workflow_runs: CiRun[] }).workflow_runs;
}

if (import.meta.main) {
  const [repo, sha, token] = [process.env.GITHUB_REPOSITORY, process.env.GITHUB_SHA, process.env.GH_TOKEN];
  if (!repo || !sha || !token) {
    console.error("release-gate: GITHUB_REPOSITORY, GITHUB_SHA and GH_TOKEN are needed");
    process.exit(2);
  }
  const LIMIT_SECONDS = 30 * 60;
  const started = Date.now();
  for (;;) {
    const waited = (Date.now() - started) / 1000;
    const runs = await runsAt(repo, sha, token);
    const verdict: Verdict = runs === "retry" ? { state: "wait", why: "GitHub's API is not answering" } : judge(runs, sha, waited);
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
