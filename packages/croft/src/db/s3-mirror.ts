// Reading a bucket folder from outside DuckDB (DESIGN.md D151; option 07, slice 3): the part of S3 that `croft backup` of a lake needs to copy the
// folder, a signed ListObjectsV2 and a signed GET, over `fetch`. It is not DuckDB's httpfs because a backup needs the files as they are (bytes
// to disk, streamed), which a SQL engine in a locked sandbox neither does nor should; and it is not Bun's own S3Client because that one ignores
// NO_PROXY (a store on this machine was sent to the proxy, in the one environment it was tried in), where `fetch` honours it.
//
// It speaks to S3, R2, MinIO and the test store the same way: AWS signature version 4, path style or virtual-hosted style. It reads only: the
// key it is given is the lake's read-only one. Nothing here prints a key; an error names the status and the store's error code, never the
// request's headers.
import { createHash, createHmac } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { storeTlsError } from "./store-tls.ts";

export interface S3Access {
  /** `host[:port]` of the store; absent for AWS. */
  endpoint?: string;
  region: string;
  useSsl: boolean;
  urlStyle: "path" | "vhost";
  bucket: string;
  keyId: string;
  secretKey: string;
  sessionToken?: string;
  /** The PEM file the store's certificate is checked against, when the project names one (db/store-tls.ts); else the runtime's own authorities. */
  caFile?: string;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters; a "/" is kept in a path. */
const enc = (s: string, keepSlash = false): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%2F/g, keepSlash ? "/" : "%2F");

export interface SignInput {
  method: string;
  host: string;
  /** The URI path, already encoded (a "/" for the top). */
  path: string;
  /** Query parameters, unencoded. */
  query: Record<string, string>;
  /** Headers to sign besides host and the x-amz ones, lower-case names. */
  headers?: Record<string, string>;
  payloadHash: string;
  keyId: string;
  secretKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  /** `20150830T123600Z`. */
  amzDate: string;
}

/** AWS signature version 4: the headers to send (Authorization, x-amz-date and x-amz-content-sha256, and x-amz-security-token with a token). */
export function signV4(i: SignInput): Record<string, string> {
  const date = i.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...(i.headers ?? {}), host: i.host, "x-amz-date": i.amzDate };
  if (i.service === "s3") headers["x-amz-content-sha256"] = i.payloadHash;
  if (i.sessionToken) headers["x-amz-security-token"] = i.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signed = names.join(";");
  const canonicalQuery = Object.keys(i.query).sort().map((k) => `${enc(k)}=${enc(i.query[k]!)}`).join("&");
  const request = [i.method, i.path, canonicalQuery, canonicalHeaders, signed, i.payloadHash].join("\n");
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256(request)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretKey}`, date), i.region), i.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const out: Record<string, string> = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.keyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
  delete out.host;
  return out;
}

/** Where a request to the bucket goes: the URL (without the query), the host header, and the path as signed. */
function target(a: S3Access, key: string): { base: string; host: string; path: string } {
  const scheme = a.useSsl ? "https" : "http";
  const keyPath = key.split("/").map((p) => enc(p)).join("/");
  if (a.urlStyle === "vhost") {
    const host = a.endpoint ? `${a.bucket}.${a.endpoint}` : `${a.bucket}.s3.${a.region}.amazonaws.com`;
    const path = `/${keyPath}`;
    return { base: `${scheme}://${host}${path}`, host, path };
  }
  const host = a.endpoint ?? `s3.${a.region}.amazonaws.com`;
  const path = `/${enc(a.bucket)}${key ? `/${keyPath}` : ""}`;
  return { base: `${scheme}://${host}${path}`, host, path };
}

export class S3Failure extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function get(a: S3Access, key: string, query: Record<string, string>): Promise<Response> {
  const t = target(a, key);
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const headers = signV4({
    method: "GET", host: t.host, path: t.path, query, payloadHash: EMPTY_SHA256, keyId: a.keyId, secretKey: a.secretKey,
    ...(a.sessionToken ? { sessionToken: a.sessionToken } : {}), region: a.region, service: "s3", amzDate,
  });
  const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k]!)}`).join("&");
  // A redirect would send the signed request, and the key's signature with it, somewhere the store did not name: refused.
  let res: Response;
  try {
    res = await fetch(`${t.base}${qs ? `?${qs}` : ""}`, { method: "GET", headers, redirect: "error",
      // Always checked: Bun's fetch honours NODE_TLS_REJECT_UNAUTHORIZED=0 and then reads a store with any certificate or none vouching for it,
      // CA file or not [V: 1.3.14]; naming `rejectUnauthorized` beats the variable (D-R1).
      tls: { rejectUnauthorized: true, ...(a.caFile ? { ca: Bun.file(a.caFile) } : {}) } });
  } catch (e) {
    // The store's certificate not checking out is LAKE_STORE_TLS here as it is for DuckDB (D-R1), not a failure of the backup's folder.
    throw storeTlsError(e, { named: !!a.caFile }) ?? e;
  }
  if (!res.ok) {
    // The store's error code names what went wrong (AccessDenied, NoSuchKey); its body may echo the key id, so only the code is kept.
    const code = /<Code>([^<]*)<\/Code>/.exec(await res.text().catch(() => ""))?.[1] ?? "";
    throw new S3Failure(`the store answered HTTP ${res.status}${code ? ` (${code})` : ""} to a read of ${key || "the bucket"}`, res.status);
  }
  return res;
}

export interface S3Object { key: string; size: number }

/** Every object under `prefix` (a "folder/" of the bucket), in key order, following the listing's pages. */
export async function* listObjects(a: S3Access, prefix: string, pageSize = 1000): AsyncGenerator<S3Object> {
  let token: string | undefined;
  do {
    const res = await get(a, "", { "list-type": "2", prefix, "max-keys": String(pageSize), ...(token ? { "continuation-token": token } : {}) });
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1]!)?.[1] ?? "");
      const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? "0");
      if (key) yield { key, size };
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || undefined : undefined;
  } while (token);
}

/** Download one object to `dest`, through a temporary name that is renamed into place once the bytes are all there and as many as listed. */
export async function downloadObject(a: S3Access, key: string, dest: string, expectBytes: number): Promise<void> {
  const res = await get(a, key, {});
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}`;
  try {
    if (!res.body) throw new S3Failure(`the store sent no body for ${key}`, res.status);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    const got = Bun.file(tmp).size;
    if (got !== expectBytes) throw new S3Failure(`${key} came to ${got} bytes; the listing said ${expectBytes}`, res.status);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
