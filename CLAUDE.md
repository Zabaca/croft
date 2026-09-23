# croft

This project uses [zbc](https://github.com/Zabaca/zbc) for infrastructure scaffolding.

## Layout

- `packages/infra/` — infrastructure code (zbc modules)
- `packages/infra/environments/` — per-environment config (`production`, `preview`)
- `packages/infra/modules/` — copy-mode: vendored infra modules (re-vendor with `zbc add`, don't edit); subtree-mode: your own modules (edit freely)
- `vendor/zbc/` — subtree-mode only: the zbc engine + built-in modules as a git subtree of Zabaca/zbc-core. Update with `bunx @zabaca/zbc update`; never mix `vendor/zbc/` and other paths in one commit, and never write your own files under `vendor/zbc/` — the prefix is upstream's, a `subtree push` carries anything in it, and `zbc update` will name them
- `.zbc-vendor.json` — which zbc engine this project vendored (mode, CLI version, core ref). Committed; refreshed by `zbc update`; `zbc apply` warns when it has drifted from the CLI running it
- `zbc.config.ts` — project-level zbc config
- `.sops.yaml` — SOPS encryption rules for secrets

## Common commands

- `bun install` — install dependencies
- `bunx @zabaca/zbc add <module>` — vendor an infra module (`turso`, `cloudflare`, `cloudflare-email`, `r2`) or scaffold an app template (`inbox` — an agent-accessible email inbox; `secret-relay` — the browser-based secret request relay; `warehouse` — a dlt+dbt-duckdb data warehouse/BI pipeline; each auto-vendors its module dependencies)
- `bunx @zabaca/zbc apply <env>` — apply infrastructure for an environment
- `bunx @zabaca/zbc apply <env> --json <path>` — the same, plus the result (`{ env, instances: [{ name, module, outputs }] }`) written to a file. Treat that file as secret: outputs carry credentials
- `bunx @zabaca/zbc list <env>` — what the environment declares, in dependency order (add `--json` for a machine-readable listing)
- `bunx @zabaca/zbc secret get <env> <key>` — print one decrypted secret on stdout, for `TOKEN=$(…)` in a local script
- `bunx @zabaca/zbc destroy <env>` — tear down every instance in an environment that defines a destroy

## Conventions

- `packages/infra/modules/*` is vendored from `@zabaca/zbc`. Re-vendor with `zbc add` rather than editing in place.
- Secrets are SOPS-encrypted under `packages/infra/environments/<env>/`. Decrypt only when needed; never commit plaintext.
