# zbc-core

The zbc infrastructure engine + built-in modules, published automatically as a
split of [Zabaca/zbc](https://github.com/Zabaca/zbc)'s
`packages/cli/templates/infra/` directory. **Do not open PRs against this
repo** — it is generated; changes belong in Zabaca/zbc (directly or via
`git subtree push` from a consumer repo).

## Consuming (subtree)

```sh
git subtree add --prefix=vendor/zbc https://github.com/Zabaca/zbc-core.git zbc-core-v<version> --squash
```

- `src/` — `defineModule`/types used by modules and your instance files
- `modules/<name>/` — built-in modules (`index.ts` + `registry.json`)

Import modules from your instance files by path
(`import { cloudflareModule } from '../../vendor/zbc/modules/cloudflare'`),
keep your own modules OUTSIDE the prefix (e.g. `packages/infra/modules/`),
and never mix `vendor/zbc/` and non-vendor paths in one commit — commits
touching the prefix are what `git subtree push` sends upstream.

Update:

```sh
git subtree pull --prefix=vendor/zbc https://github.com/Zabaca/zbc-core.git zbc-core-v<version> --squash
```

Contribute back:

```sh
git subtree push --prefix=vendor/zbc git@github.com:Zabaca/zbc-core.git my-feature
```

then PR `my-feature` in Zabaca/zbc-core — a maintainer lands it in
Zabaca/zbc's `packages/cli/templates/infra/` (the authoring home), and the
next publish flows it back out here.

Tags mirror the CLI version: `zbc-core-v<x.y.z>`.
