---
title: Install
description: croft needs Bun 1.3.14 or newer on macOS or Linux. One global launcher, and a pinned copy per project.
---

croft needs [Bun](https://bun.sh) 1.3.14 or newer, on macOS or Linux. Native Windows is not supported; WSL works, with the project inside the Linux filesystem rather than under `/mnt/c`.

```sh
bun --version                    # 1.3.14 or newer
bun add -g @zabaca/croft         # the croft launcher, in ~/.bun/bin
croft --version
```

If `bun --version` fails or prints an older version, install or upgrade Bun first:

```sh
curl -fsSL https://bun.sh/install | bash
```

## The launcher and the pinned copy

The global `croft` is only a launcher. Every project pins its own croft version in its `package.json`, and the launcher finds the nearest `croft.json`, changes into that project and runs the project's pinned copy. So the global and project versions can never disagree, and upgrading croft is a change to one project's `package.json`, not to your machine.

- Outside a project, only `init`, `doctor`, `docs`, `help` and `--version` work.
- After a `git clone`, the first command that can change data runs `bun install` for you.
- If `~/.bun/bin` is not on your `PATH`, `bunx croft` inside a project runs the same pinned copy.

## What it installs

croft has one runtime dependency, `@duckdb/node-api`, pinned exactly. It ships prebuilt DuckDB libraries for macOS and Linux (x64 and arm64), with the `json`, `parquet` and `icu` extensions built in, so croft never downloads an extension. `bun.lock` is the whole environment.

## Check the machine

```sh
croft doctor
```

`croft doctor` checks Bun, the DuckDB binding, where the warehouse lives, whether the folder is writable, and whether the Claude files match the CLI. It never writes data. Each problem it finds comes with its code and a fix on the next line; [every code has a page](/docs/reference/errors/).

## Synced folders

iCloud (`~/Documents` and `~/Desktop` on many Macs), Dropbox, OneDrive and network drives can corrupt a DuckDB file mid-write and break its locks. When `croft init` sees such a folder, it puts the database and the `.croft/` state folder in `~/.local/share/croft/` instead, records the paths in `croft.json`, and says so. Your asset files stay where you created the project.

Next: the [Quickstart](/docs/quickstart/).
