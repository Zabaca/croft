// A project whose warehouse is a lake, built the way a person's first run builds it, for tests that need one in this process (option 07,
// slice 2): a temp project (inspect-testkit.ts) with a `lake` block and its secrets, and an SQL asset `orders` that croft itself runs, so the
// lake holds a real table with its bookkeeping. Test support, left out of the published package.
import { expect } from "bun:test";
import { closeAllWarehouses } from "../../db/warehouse.ts";
import { type LakeRig, localLakeBlock, type RigLake, useLake } from "../../db/lake-testkit.ts";
import { loadProject, type Project } from "../../project/root.ts";
import { cli, makeProject, type TestProject } from "./inspect-testkit.ts";

export const ORDERS_SQL = "-- description: orders\n-- key: id\nSELECT range AS id, range % 7 AS k, 'o' || range AS note FROM range(20)\n";

export interface LakeProject {
  p: TestProject;
  project: Project;
  /** The environment to run croft with: the extension folder, and the secrets when the lake is shared. */
  env: Record<string, string>;
  /** The lake's folder as SQL would write it (`s3://bucket/folder/`, or the local data folder with a trailing slash). */
  bucket: string;
  /** The shared lake, when there is one. */
  shared: RigLake | null;
}

/** A lake project with `orders` built (20 rows). `rig` is needed for a shared lake (Postgres and a store); a local one needs none. */
export async function lakeProject(kind: "local" | "postgres", o: { extensionDir: string; rig?: LakeRig; lake?: RigLake; files?: Record<string, string> }): Promise<LakeProject> {
  const p = makeProject({ files: { "files/x.csv": "a,b\n1,2\n", "assets/orders.sql": ORDERS_SQL, ...o.files } });
  const shared = kind === "postgres" ? o.lake ?? await o.rig!.lake() : null;
  useLake(p.root, { block: shared ? shared.block : localLakeBlock(), ...(shared ? { env: shared.env } : {}) });
  const env: Record<string, string> = { CROFT_EXTENSION_DIR: o.extensionDir, ...(shared?.env ?? {}) };
  const built = await cli(["run", "orders", "--foreground", "--json"], { cwd: p.root, env });
  expect(built.exit, built.stdout).toBe(0);
  await closeAllWarehouses(); // this process held the lake as the writer; what comes next attaches it read-only
  const project = loadProject({ root: p.root });
  return { p, project, env, bucket: shared ? `s3://${shared.bucket}/${shared.folder}/` : `${p.root}/lake/data/`, shared };
}
