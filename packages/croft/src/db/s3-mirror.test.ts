// The read-only S3 client a lake's backup uses (db/s3-mirror.ts; DESIGN.md D151): the signature against AWS's published example, and a listing
// and a download against the test store (which pages its listings at the size it is asked for).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startS3, type TestS3 } from "./mode-testkit.ts";
import { downloadObject, listObjects, type S3Access, S3Failure, signV4 } from "./s3-mirror.ts";

describe("AWS signature version 4", () => {
  test("is AWS's own worked example (IAM ListUsers, 2015-08-30)", () => {
    const h = signV4({
      method: "GET", host: "iam.amazonaws.com", path: "/", query: { Action: "ListUsers", Version: "2010-05-08" },
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      keyId: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "iam", amzDate: "20150830T123600Z",
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

let s3: TestS3;
let dir: string;
beforeAll(async () => {
  s3 = await startS3({ buckets: ["lakeb"], keys: { RKEY: "ro", WKEY: "rw" } });
  dir = mkdtempSync(join(tmpdir(), "croft-s3mirror-"));
  for (let i = 0; i < 25; i++) {
    const f = join(s3.root, "lakeb", "proj", "main", "t", `f${String(i).padStart(2, "0")} & more.parquet`);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, "x".repeat(10 + i));
  }
  writeFileSync(join(s3.root, "lakeb", "other.txt"), "not this lake's");
});
afterAll(async () => {
  await s3.stop();
  rmSync(dir, { recursive: true, force: true });
});

const access = (over: Partial<S3Access> = {}): S3Access => ({ endpoint: s3.endpoint, region: "us-east-1", useSsl: false, urlStyle: "path", bucket: "lakeb", keyId: "RKEY", secretKey: "secret", ...over });

describe("a folder of a bucket", () => {
  test("is listed across pages, only under the prefix, with sizes", async () => {
    const seen: { key: string; size: number }[] = [];
    for await (const o of listObjects(access(), "proj/", 10)) seen.push(o);
    expect(seen.length).toBe(25);
    expect(seen[0]).toEqual({ key: "proj/main/t/f00 & more.parquet", size: 10 });
    expect(seen.every((o) => o.key.startsWith("proj/"))).toBe(true);
  });

  test("is downloaded byte for byte, and a size that is not the listing's is a failure that leaves no file", async () => {
    const to = join(dir, "out", "f03.parquet");
    await downloadObject(access(), "proj/main/t/f03 & more.parquet", to, 13);
    expect(readFileSync(to, "utf8")).toBe("x".repeat(13));
    await expect(downloadObject(access(), "proj/main/t/f04 & more.parquet", join(dir, "out", "f04.parquet"), 999)).rejects.toThrow(/came to 14 bytes/);
    expect(readdirSync(join(dir, "out"))).toEqual(["f03.parquet"]);
  });

  test("a key the store does not know is refused, and the error does not carry the key", async () => {
    const err = await (async () => {
      for await (const _ of listObjects(access({ keyId: "UNKNOWNKEYID1234" }), "proj/")) void _;
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3Failure);
    expect((err as S3Failure).status).toBe(403);
    expect((err as Error).message).toContain("InvalidAccessKeyId");
    expect((err as Error).message).not.toContain("UNKNOWNKEYID1234");
  });
});
