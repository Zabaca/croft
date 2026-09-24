# TRANSFORM_MAKES_REQUESTS: a full-refresh transform makes requests (warning)

A TypeScript transform without incremental: true recomputes every row whenever an input or its code changes.
Its code makes requests (ctx.http, fetch(), or an HTTP or LLM SDK such as openai or @anthropic-ai/sdk, also
through lib/), so every rebuild pays for every row again. The cost guard (LARGE_REPROCESS) covers incremental
transforms only.

What to do: make it incremental, so each input row is processed once:

    key: "issue_id",
    incremental: true,
    async *rows({ newRows, http }) {
      for await (const issue of newRows<Issue>("github_issues")) {
        // one request per issue, then:
        yield { issue_id: issue.id /* , ... */ };
      }
    },

Every input read with newRows() needs a key (INPUT_NEEDS_KEY). croft docs transforms has the whole template.

The detection reads the bundled code, so an unrelated variable named http counts too: rename it if the
transform makes no requests.
