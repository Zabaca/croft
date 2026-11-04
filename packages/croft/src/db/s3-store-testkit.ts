// A minimal S3-compatible object store for croft's lake-mode tests (DESIGN.md D118). Run as a child process of the
// test (see mode-testkit.ts), never installed and never left running:
//
//   bun s3-store-testkit.ts --root <dir> --bucket <name> --key <id>:rw --key <id>:ro [--port 0] [--tls-cert <pem> --tls-key <pem>]
//
// With a certificate and key (PEM files) it serves HTTPS, as a real store does; without them, plain HTTP. It prints `LISTENING <port>` once it serves. It speaks the part of S3 that DuckDB's httpfs uses against a bucket
// in path style over plain HTTP: HEAD, GET (with Range), PUT, DELETE, the ListObjectsV2 listing, multipart upload and
// the multi-object delete. It checks only WHO is asking, not the request signature: an access key id it does not
// know gets 403 InvalidAccessKeyId, and a read-only key that writes gets 403 AccessDenied, each echoing the key id
// in the XML body the way a real store's refusal does (so a test can prove croft redacts it). A bucket it was not
// given is 404 NoSuchBucket. Objects are files under <root>/<bucket>/.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";

function arg(name: string): string[] {
  const out: string[] = [];
  const a = process.argv;
  for (let i = 0; i < a.length; i++) if (a[i] === `--${name}` && a[i + 1] !== undefined) out.push(a[i + 1]!);
  return out;
}

const root = arg("root")[0]!;
const buckets = new Set(arg("bucket"));
const keys = new Map(arg("key").map((k) => { const [id, mode] = k.split(":"); return [id!, mode === "ro" ? "ro" : "rw"] as const; }));
mkdirSync(root, { recursive: true });
for (const b of buckets) mkdirSync(join(root, b), { recursive: true });

const xml = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { status, headers: { "content-type": "application/xml", ...headers } });
const err = (status: number, code: string, message: string, extra = "") =>
  xml(status, `<Error><Code>${code}</Code><Message>${message}</Message>${extra}</Error>`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const etag = (b: Uint8Array) => `"${createHash("md5").update(b).digest("hex")}"`;

const uploads = new Map<string, Map<number, Uint8Array>>();

// Faults a test asks for over HTTP (POST /__control?failDeletes=N&status=500, GET /__control for the counts; no key needed, the
// store is on 127.0.0.1 and a child of the test): the next N requests that delete objects (a bulk delete or a single one) answer
// `status` and delete nothing, as R2 answered HTTP 500 to bulk deletes on a real lake. Counts say how many deletes were asked for
// and how many objects went.
const faults = { failDeletes: 0, status: 500 };
const counts = { deleteRequests: 0, failedDeletes: 0, objectsDeleted: 0 };

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const tlsCert = arg("tls-cert")[0];
const tlsKey = arg("tls-key")[0];

const server = Bun.serve({
  port: Number(arg("port")[0] ?? 0),
  hostname: "127.0.0.1",
  ...(tlsCert && tlsKey ? { tls: { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) } } : {}),
  async fetch(req) {
    const url = new URL(req.url);
    const m = req.method;
    if (url.pathname === "/__control") {
      if (m === "POST") {
        faults.failDeletes = Number(url.searchParams.get("failDeletes") ?? faults.failDeletes);
        faults.status = Number(url.searchParams.get("status") ?? faults.status);
      }
      return new Response(JSON.stringify({ ...faults, ...counts }), { headers: { "content-type": "application/json" } });
    }
    const deleting = (m === "POST" && url.searchParams.has("delete")) || m === "DELETE";
    if (deleting && !url.searchParams.has("uploadId")) {
      counts.deleteRequests++;
      if (faults.failDeletes > 0) {
        faults.failDeletes--;
        counts.failedDeletes++;
        return err(faults.status, faults.status >= 500 ? "InternalError" : "SlowDown", "We encountered an internal error. Please try again.");
      }
    }
    const credential = /Credential=([^/,\s]+)\//.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!credential || !keys.has(credential)) {
      return err(403, "InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.", `<AWSAccessKeyId>${esc(credential ?? "")}</AWSAccessKeyId>`);
    }
    const writes = m === "PUT" || m === "DELETE" || (m === "POST");
    if (writes && keys.get(credential) === "ro") {
      return err(403, "AccessDenied", "Access Denied", `<AWSAccessKeyId>${esc(credential)}</AWSAccessKeyId>`);
    }
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split("/");
    if (!bucket || !buckets.has(bucket)) return err(404, "NoSuchBucket", "The specified bucket does not exist", `<BucketName>${esc(bucket ?? "")}</BucketName>`);
    const key = rest.join("/");
    const file = join(root, bucket, key);

    if (!key) {
      if (m === "GET") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        const maxKeys = Math.max(1, Number(url.searchParams.get("max-keys") ?? 1000));
        const after = url.searchParams.get("continuation-token") ?? url.searchParams.get("start-after") ?? "";
        const everything = listFiles(join(root, bucket)).map((f) => relative(join(root, bucket), f)).filter((k) => k.startsWith(prefix)).sort();
        // As S3 pages a listing: a key and a rolled-up folder (a common prefix) are one entry each, in order, `max-keys` entries to a page, and the
        // token names the last entry sent. Paging the keys first and rolling up after sends a folder of more than a page of keys once per page.
        const entries: { name: string; key: boolean }[] = [];
        for (const k of everything) {
          const rel = k.slice(prefix.length);
          const cut = delimiter ? rel.indexOf(delimiter) : -1;
          const name = cut >= 0 ? prefix + rel.slice(0, cut + delimiter!.length) : k;
          if (cut >= 0 && entries.at(-1)?.name === name) continue;
          entries.push({ name, key: cut < 0 });
        }
        const left = entries.filter((e) => e.name > after);
        const page = left.slice(0, maxKeys);
        const truncated = left.length > page.length;
        const contents = page.filter((e) => e.key).map((e) => {
          const st = statSync(join(root, bucket, e.name));
          return `<Contents><Key>${esc(e.name)}</Key><LastModified>${st.mtime.toISOString()}</LastModified><ETag>"x"</ETag><Size>${st.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
        });
        const prefixes = page.filter((e) => !e.key).map((e) => e.name);
        const all = page.map((e) => e.name);
        return xml(200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${esc(all[all.length - 1]!)}</NextContinuationToken>` : ""}${contents.join("")}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`);
      }
      if (m === "POST" && url.searchParams.has("delete")) {
        const body = await req.text();
        const gone = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((x) => x[1]!);
        for (const k of gone) rmSync(join(root, bucket, k), { force: true });
        counts.objectsDeleted += gone.length;
        return xml(200, `<DeleteResult>${gone.map((k) => `<Deleted><Key>${k}</Key></Deleted>`).join("")}</DeleteResult>`);
      }
      return err(400, "InvalidRequest", "unsupported bucket request");
    }

    if (m === "POST" && url.searchParams.has("uploads")) {
      const id = randomUUID();
      uploads.set(id, new Map());
      return xml(200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (m === "PUT" && url.searchParams.has("uploadId")) {
      const parts = uploads.get(url.searchParams.get("uploadId")!);
      if (!parts) return err(404, "NoSuchUpload", "no such upload");
      const body = new Uint8Array(await req.arrayBuffer());
      parts.set(Number(url.searchParams.get("partNumber")), body);
      return new Response("", { status: 200, headers: { etag: etag(body) } });
    }
    if (m === "POST" && url.searchParams.has("uploadId")) {
      const id = url.searchParams.get("uploadId")!;
      const parts = uploads.get(id);
      if (!parts) return err(404, "NoSuchUpload", "no such upload");
      const buf = Buffer.concat([...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buf);
      uploads.delete(id);
      return xml(200, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><ETag>"m"</ETag></CompleteMultipartUploadResult>`);
    }
    if (m === "PUT") {
      const body = new Uint8Array(await req.arrayBuffer());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      return new Response("", { status: 200, headers: { etag: etag(body) } });
    }
    if (m === "DELETE") {
      counts.objectsDeleted++;
      rmSync(file, { force: true });
      return new Response(null, { status: 204 });
    }
    if (m === "GET" || m === "HEAD") {
      if (!existsSync(file) || statSync(file).isDirectory()) return m === "HEAD" ? new Response(null, { status: 404 }) : err(404, "NoSuchKey", "The specified key does not exist.", `<Key>${esc(key)}</Key>`);
      const st = statSync(file);
      const data = readFileSync(file);
      const headers = { "last-modified": st.mtime.toUTCString(), etag: etag(data), "accept-ranges": "bytes" };
      if (m === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "content-length": String(st.size) } });
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
      if (range) {
        const from = Number(range[1]);
        const to = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        return new Response(data.subarray(from, to + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${from}-${to}/${st.size}` } });
      }
      return new Response(data, { status: 200, headers });
    }
    return err(405, "MethodNotAllowed", "method not allowed");
  },
});
console.log(`LISTENING ${server.port}`);
