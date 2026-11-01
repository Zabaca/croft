// A minimal S3-compatible object store for croft's lake-mode tests (DESIGN.md D118). Run as a child process of the
// test (see mode-testkit.ts), never installed and never left running:
//
//   bun s3-store-testkit.ts --root <dir> --bucket <name> --key <id>:rw --key <id>:ro [--port 0]
//
// It prints `LISTENING <port>` once it serves. It speaks the part of S3 that DuckDB's httpfs uses against a bucket
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

const server = Bun.serve({
  port: Number(arg("port")[0] ?? 0),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const m = req.method;
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
        const all = listFiles(join(root, bucket)).map((f) => relative(join(root, bucket), f)).filter((k) => k.startsWith(prefix)).sort();
        const contents: string[] = [];
        const prefixes = new Set<string>();
        for (const k of all) {
          const rel = k.slice(prefix.length);
          const cut = delimiter ? rel.indexOf(delimiter) : -1;
          if (cut >= 0) prefixes.add(prefix + rel.slice(0, cut + delimiter!.length));
          else {
            const st = statSync(join(root, bucket, k));
            contents.push(`<Contents><Key>${esc(k)}</Key><LastModified>${st.mtime.toISOString()}</LastModified><ETag>"x"</ETag><Size>${st.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`);
          }
        }
        return xml(200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents.join("")}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`);
      }
      if (m === "POST" && url.searchParams.has("delete")) {
        const body = await req.text();
        const gone = [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map((x) => x[1]!);
        for (const k of gone) rmSync(join(root, bucket, k), { force: true });
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
