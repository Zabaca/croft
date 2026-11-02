# Lake mode: the warehouse is a DuckLake, written by one machine and read by anyone given access

By default a project's warehouse is one DuckDB file on one machine. In lake mode it is a DuckLake instead: a catalog
(a Postgres database) and the table data as Parquet files in a bucket folder of an S3-compatible store (R2, S3, MinIO).
The data then outlives the machine, and readers never wait for a run: everyone reads the snapshot that was last
committed while the writer works on the next. It is opt-in, and a project that never names a lake is the file it was:
nothing is loaded, nothing changes.

You use croft as before: `croft run`, `query`, `status`, `describe`, `delete`, `restore`, `rename`, `preview`, the
scheduler, `croft serve`. Writes stay all-or-nothing with their bookkeeping, checks run before saving, and the trash
stays on the writing machine as local files. What lake mode adds is a setup that is more than "a first warehouse in
minutes": a Postgres, a bucket folder, two logins and two bucket keys. Turning it on is the user's decision.

## Setting it up (shared lake)

Whoever runs the Postgres and the bucket makes:
- a Postgres database for the catalog, with two logins: a writer that owns it, and a read-only login (SELECT only);
- a bucket and, in it, a folder that holds NOTHING BUT this lake: DuckLake's own cleanup deletes any file in the folder
  that it does not recognise, so never put anything else there (croft doctor says so);
- two bucket keys: one that writes the folder, one that can only read it.

The project names them in croft.json, by the NAMES of the secrets that hold the passwords and keys (never the values):

    "lake": {
      "catalog": {
        "kind": "postgres", "host": "db.example.com", "port": 5432, "database": "croft_lake",
        "writer": { "user": "croft_writer", "passwordSecret": "LAKE_WRITER_PASSWORD" },
        "reader": { "user": "croft_reader", "passwordSecret": "LAKE_READER_PASSWORD" }
      },
      "bucket": {
        "name": "my-bucket", "folder": "croft/orders/", "endpoint": "abc123.r2.cloudflarestorage.com", "region": "auto",
        "writer": { "keyIdSecret": "LAKE_WRITER_KEY_ID", "secretKeySecret": "LAKE_WRITER_KEY" },
        "reader": { "keyIdSecret": "LAKE_READER_KEY_ID", "secretKeySecret": "LAKE_READER_KEY" }
      }
    }

The secrets live in .env, the shell or the secretsFrom command, like any other (croft docs secrets). Then install the
lake add-on, which carries DuckDB's ducklake, httpfs and postgres extensions (croft docs addons), and check:

    bun add @zabaca/croft-addon-lake@<version>
    croft validate && croft doctor && croft run

The first `croft run` creates the lake, at DuckLake format 1.0 (so DuckDB 1.5 can read it too). croft never lets
DuckLake migrate a catalog by itself. The writer's login and key are used only by commands that write; `croft serve`,
`croft query`, `croft status`, `croft doctor` and the rest attach read-only with the read-only login and key. The
read-only key is what keeps a reader that got past the gate out of the bucket, so it must not be able to write.

## A local lake (development)

    "lake": { "catalog": { "kind": "sqlite", "path": "lake/catalog.sqlite" }, "dataPath": "lake/data" }

A SQLite catalog and a folder, for one machine and for trying lake mode: no Postgres, no bucket, no logins. It needs the
lake add-on too, and DuckDB's sqlite extension, which no add-on ships (it is for development and croft's own tests: from
a source checkout, scripts/fetch-extensions.ts puts it where croft looks). There is no key to keep a reader out of the
folder, so the gate is the only wall. Do not use it to share data.

## One writing machine

One machine writes a lake, one write at a time. croft takes a lock of its own on the machine (`.croft/lake-write.lock`)
in place of the file's lock: a second `croft run` waits for the first, then gets DB_BUSY naming the holder; a writer
that was killed is reclaimed by the next. Every write records which machine made it (`_croft.meta`, key last_writer),
and `croft doctor` warns with LAKE_OTHER_WRITER when another machine wrote since. Writing from two machines is not
supported: they would not know of each other's runs. A machine is told apart by the platform's machine id; where that
changes at every start (some containers), set CROFT_MACHINE_ID to a fixed name in the environment that runs croft.

A lost connection is mended by croft: a read whose catalog connection dropped is tried again, and a write is tried again
as a whole after croft checks by the tag its commit carries whether the commit landed (a landed commit is never run
again). What is left is LAKE_CONNECTION_LOST or LAKE_COMMIT_UNCERTAIN.

## Reading

- `croft query`, `status`, `describe`, `context`, `doctor`: as before.
- Apps: through `croft serve` (`@zabaca/croft/read` finds it). In a lake project croft serve reads the last snapshot
  with the read-only login and key, never steps aside for a run and never answers "busy". Direct mode, which opens the
  warehouse file, refuses (LAKE_DIRECT_READ). A key (croft serve key) works in server mode only, and server mode over
  a lake is not built yet.
- Analysts, from their own DuckDB 2.0, without croft: whoever runs the Postgres makes a login that can only read, and
  the bucket a key that can only read the folder. They see every table of the lake (limiting a person to chosen tables
  is what server mode over a lake will add). The recipe, run by the person who runs the Postgres:

```sql postgres-admin
CREATE ROLE <analyst> LOGIN PASSWORD '<analyst_password>';
GRANT CONNECT ON DATABASE <database> TO <analyst>;
GRANT USAGE ON SCHEMA public TO <analyst>;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO <analyst>;
ALTER DEFAULT PRIVILEGES FOR ROLE <writer> IN SCHEMA public GRANT SELECT ON TABLES TO <analyst>;
```

  and by the analyst, in DuckDB 2.0 (INSTALL fetches the extensions once; croft is not involved):

```sql duckdb-reader
INSTALL ducklake; INSTALL postgres; INSTALL httpfs;
CREATE SECRET lake_catalog (TYPE postgres, HOST '<host>', PORT <port>, DATABASE '<database>', USER '<analyst>', PASSWORD '<analyst_password>');
CREATE SECRET lake_files (TYPE s3, KEY_ID '<key_id>', SECRET '<key_secret>', ENDPOINT '<endpoint>', URL_STYLE 'path', USE_SSL <use_ssl>, SCOPE 's3://<bucket>/<folder>/');
ATTACH 'ducklake:postgres:' AS lake (META_SECRET lake_catalog, DATA_PATH 's3://<bucket>/<folder>/', READ_ONLY);
USE lake;
```

  They then query the tables, and `FROM lake.snapshots()` or `SELECT ... FROM t AT (VERSION => <n>)` show the lake as it
  was. An attempt to write a table, or a file in the bucket, is refused (by the attach, by the store, by Postgres).
  Never give an analyst the writer's login or key, and never put a password in the ATTACH text: it shows in errors and
  in `duckdb_databases()`.

## What SQL cannot reach

The gate refuses, in a lake project, everything that reaches past the tables, for `croft query`, SQL assets, checks and
`ctx.query`: `postgres_query` and `postgres_execute` (which would let SQL rewrite the catalog), `duckdb_secrets()` and
`duckdb_databases()` (which show the bucket key and the catalogs), the lake's metadata catalog (`__ducklake_metadata_*`),
the lake's own functions and the bucket's files (`read_parquet('s3://...')` and the like). QUERY_PATH_DENIED.

## Types a lake cannot store

DuckLake stores no ENUM, UNION or VARINT column. A result that has one fails before anything is written, with
LAKE_TYPE_UNSUPPORTED and the cast that fixes it (`CAST(col AS VARCHAR)`).

## Not in this release

- Maintenance. croft does not yet expire snapshots, merge small files or clean up, so a lake grows with every run (and
  the catalog holds small tables' rows inline). Do not run CHECKPOINT on a lake yourself and do not set an expiry option
  on it: CHECKPOINT runs DuckLake's maintenance from the lake's stored options, and an age-based expiry would delete
  versions the trash promises to keep. croft will run each maintenance step itself.
- `croft backup` (LAKE_UNSUPPORTED): back the lake up with the tools of whoever runs the Postgres and the bucket.
- Moving an existing project's file into a lake, and server mode over a lake.

Codes: LAKE_ATTACH_FAILED, LAKE_CONNECTION_LOST, LAKE_COMMIT_UNCERTAIN, LAKE_TYPE_UNSUPPORTED, LAKE_DIRECT_READ,
LAKE_UNSUPPORTED, LAKE_OTHER_WRITER (croft docs <CODE>), and EXTENSION_MISSING when the add-on is not installed.
