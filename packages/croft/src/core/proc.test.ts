import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { bootId, currentIdentity, isAlive, procStart } from "./proc.ts";

test("current process is alive", () => {
  expect(isAlive(currentIdentity())).toBe(true);
});

test("a different boot id or start time means dead", () => {
  const me = currentIdentity();
  expect(isAlive({ ...me, bootId: "other-boot" })).toBe(false);
  expect(isAlive({ ...me, procStart: "Mon Jan  1 00:00:00 2001" })).toBe(false);
});

test("an exited child is dead", async () => {
  const child = spawn("sleep", ["0.05"]);
  const id = { pid: child.pid!, procStart: procStart(child.pid!)!, bootId: bootId() };
  expect(isAlive(id)).toBe(true);
  await new Promise((r) => child.on("exit", r));
  expect(isAlive(id)).toBe(false);
});

test("an unknown start time falls back to PID existence", () => {
  const me = currentIdentity();
  expect(isAlive({ ...me, procStart: "unknown" })).toBe(true);
  expect(isAlive({ pid: 2 ** 22 + 12345, procStart: "unknown", bootId: me.bootId })).toBe(false);
});

// A holder records its start time in its own environment and a checker reads it in another: a German
// terminal against the C-locale scheduler, or a different TZ. Both must see the same value.
const PROC = JSON.stringify(join(import.meta.dir, "proc.ts"));

async function reporter(env: Record<string, string>) {
  const child = spawn(process.execPath, ["-e", `
    import { procStart } from ${PROC};
    console.log(JSON.stringify({ self: procStart(process.pid), parent: procStart(${process.pid}) }));
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const line = await createInterface({ input: child.stdout! })[Symbol.asyncIterator]().next();
  const seen = JSON.parse(String(line.value)) as { self: string; parent: string };
  const fromHere = procStart(child.pid!);
  child.kill("SIGKILL");
  return { ...seen, fromHere };
}

test("start times do not depend on the locale or time zone of the process reading them", async () => {
  const de = await reporter({ LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8", TZ: "America/Los_Angeles" });
  const c = await reporter({ LC_ALL: "C", TZ: "Asia/Kolkata" });
  const mine = currentIdentity().procStart;
  for (const r of [de, c]) {
    expect(r.fromHere).toBe(r.self);   // the child's record matches what this process reads
    expect(r.parent).toBe(mine);       // and the child reads this process's start as this process does
  }
}, 20_000);

test.skipIf(process.platform === "linux")("macOS start times are epoch seconds", () => {
  const start = Number(currentIdentity().procStart);
  expect(Number.isInteger(start)).toBe(true);
  expect(Math.abs(start - (Date.now() / 1000 - process.uptime()))).toBeLessThan(3);
});

// Records written before start times were normalized hold `ps -o lstart` text in the writer's locale and zone.
const legacy = (env: Record<string, string>) =>
  spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/bin:/usr/bin", ...env } }).stdout.trim();

test.skipIf(process.platform === "linux")("old-format records of a live process still match, whatever locale and zone wrote them", () => {
  const me = currentIdentity();
  for (const env of [
    { LC_ALL: "C", TZ: "UTC" }, { LC_ALL: "C", TZ: "America/Los_Angeles" }, { LC_ALL: "de_DE.UTF-8", TZ: "Europe/Berlin" },
    { LC_ALL: "fr_FR.UTF-8", TZ: "Asia/Kolkata" }, { LC_ALL: "ja_JP.UTF-8", TZ: "Asia/Tokyo" }, { LC_ALL: "C", TZ: "Asia/Kathmandu" },
  ]) {
    const text = legacy(env);
    expect(text).toMatch(/\d:\d\d:\d\d/);
    expect({ env, alive: isAlive({ ...me, procStart: text }) }).toEqual({ env, alive: true });
  }
});

test.skipIf(process.platform === "linux")("old-format records of another start time do not match", () => {
  const me = currentIdentity();
  const start = new Date(Number(me.procStart) * 1000);
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n: number) => String(n).padStart(2, "0");
  // What `ps -o lstart` printed under LC_ALL=C in a zone `offsetS` east of UTC.
  const c = (d: Date, offsetS = 0) => {
    const l = new Date(d.getTime() + offsetS * 1000);
    return `${DAYS[l.getUTCDay()]} ${MONTHS[l.getUTCMonth()]} ${String(l.getUTCDate()).padStart(2)} ${p2(l.getUTCHours())}:${p2(l.getUTCMinutes())}:${p2(l.getUTCSeconds())} ${l.getUTCFullYear()}`;
  };
  const de = (d: Date) => `Mi. ${d.getUTCDate()} Sep. ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
  const shift = (s: number) => new Date(start.getTime() + s * 1000);
  expect(isAlive({ ...me, procStart: c(start, 2 * 3600) })).toBe(true);        // control
  expect(isAlive({ ...me, procStart: c(start, 5.5 * 3600) })).toBe(true);
  expect(isAlive({ ...me, procStart: c(shift(1)) })).toBe(false);              // a second later
  expect(isAlive({ ...me, procStart: c(shift(15 * 60), 0) })).toBe(true);      // indistinguishable from a zone 15 min east
  expect(isAlive({ ...me, procStart: c(shift(86_400)) })).toBe(false);         // a day later: no zone is that far off
  expect(isAlive({ ...me, procStart: de(shift(-1)) })).toBe(false);
  expect(isAlive({ ...me, procStart: de(shift(-3 * 365 * 86_400)) })).toBe(false);   // years apart
  expect(isAlive({ ...me, procStart: "gone" })).toBe(false);
});
