// Imported by every test file, last, through the plugin of tests/preload.ts as `await import(".../file-guard.ts?f=<hex of the file>")`:
// the query makes it a module of its own per file, so this body runs once for each. It takes the file's baseline of processes as the
// file finishes loading, and registers the check as the last afterAll of the file (tests/leak-guard.ts says what it checks).
import { afterAll } from "bun:test";
import { relative } from "node:path";
import { assertNoLeaks, PACKAGE_ROOT, pidsNow } from "./leak-guard.ts";

const hex = new URL(import.meta.url).searchParams.get("f");
if (!hex) throw new Error("tests/file-guard.ts is imported by tests/preload.ts only, with the test file's path in ?f=");
const path = Buffer.from(hex, "hex").toString("utf8");
const file = relative(PACKAGE_ROOT, path).startsWith("..") ? path : relative(PACKAGE_ROOT, path); // a file outside the package (the guard's own test) by its whole path
const before = pidsNow();

afterAll(() => assertNoLeaks(file, before));
