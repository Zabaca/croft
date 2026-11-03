import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { bootId, currentIdentity, isAlive, knownBoot, macBootId, procStart, recordAlive, sameBoot, UNKNOWN_BOOT } from "./proc.ts";

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

test.skipIf(process.platform !== "darwin")("on macOS the boot id is the boot session UUID, which the clock does not move (kern.boottime does)", () => {
  expect(bootId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("a boot id of the old macOS kind (boottime seconds) is the same boot when the clock stepped, and is no evidence against a UUID", () => {
  const UUID_A = "5D5DD5DD-CB11-4C93-A86D-1D64A20EA230";
  const UUID_B = "0B1CE9A4-2C63-4B8D-8B8D-0A2F7D4A9C11";
  expect(sameBoot("1790105420", "1790105421")).toBe(true); // a one-second step of the clock, seen in a full run of this suite
  expect(sameBoot("1790105420", "1790105420")).toBe(true);
  expect(sameBoot("1790105420", String(1790105420 + 7200))).toBe(false); // two hours on: a machine that restarted
  expect(sameBoot("1790105420", UUID_A)).toBe(true); // written before the UUID was read: unknown, not another boot
  expect(sameBoot(UUID_A, "1790105420")).toBe(true);
  expect(sameBoot(UUID_A, UUID_B)).toBe(false);
  expect(sameBoot("other-boot", "another-boot")).toBe(false);
});

test("a step of the clock moves kern.boottime by its seconds and is still one boot: the UUID when sysctl has it, the seconds, tolerated, when it does not", () => {
  const boottime = (sec: number) => `{ sec = ${sec}, usec = 123 } Tue Sep 22 12:30:21 2026\n`;
  const withUuid = (sec: number) => macBootId((name) => (name === "kern.bootsessionuuid" ? "5D5DD5DD-CB11-4C93-A86D-1D64A20EA230\n" : boottime(sec)));
  expect(withUuid(1790105420)).toBe("5D5DD5DD-CB11-4C93-A86D-1D64A20EA230");
  expect(withUuid(1790105421)).toBe(withUuid(1790105420)); // the boot time moved by a second: the id did not
  const bare = (sec: number) => macBootId((name) => (name === "kern.boottime" ? boottime(sec) : null));
  expect(bare(1790105420)).toBe("1790105420");
  expect(bare(1790105421)).not.toBe(bare(1790105420)); // as they read before: two ids for one boot ...
  expect(sameBoot(bare(1790105420), bare(1790105421))).toBe(true); // ... that are one boot
  expect(sameBoot(bare(1790105420), bare(1790105420 + 7200))).toBe(false);
  expect(macBootId(() => null)).toBe(""); // nothing to read: unknown, which the caller makes UNKNOWN_BOOT
});

test("the boot id is read, never empty", () => {
  expect(bootId()).not.toBe("");
  expect(bootId()).not.toBe(UNKNOWN_BOOT);
  expect(knownBoot(bootId())).toBe(true);
});

test("an empty or unknown boot id is unknown, not dead: the PID and start time decide", () => {
  const me = currentIdentity();
  for (const b of ["", UNKNOWN_BOOT]) {
    expect(sameBoot(b)).toBe(true);
    expect(sameBoot(me.bootId, b)).toBe(true);
    expect(isAlive({ ...me, bootId: b })).toBe(true);
    // Still dead when the start time does not match or the PID is gone.
    expect(isAlive({ ...me, bootId: b, procStart: "1" })).toBe(false);
    expect(isAlive({ pid: 2 ** 22 + 12345, procStart: me.procStart, bootId: b })).toBe(false);
  }
  expect(sameBoot("other-boot")).toBe(false);
  expect(recordAlive({ pid: me.pid, procStart: me.procStart, bootId: null })).toBe(true);
  expect(recordAlive({ pid: me.pid, procStart: me.procStart, bootId: "" })).toBe(true);
  expect(recordAlive({ pid: null, procStart: me.procStart, bootId: me.bootId })).toBe(false);
  expect(recordAlive({ pid: me.pid, procStart: null, bootId: me.bootId })).toBe(false);
});

// An agent's shell or a launchd job may have a PATH without /usr/sbin (where macOS keeps sysctl), or none.
for (const PATH of ["", "/usr/bin:/bin", "/nonexistent"]) {
  test(`with PATH=${JSON.stringify(PATH)} the boot id and start times are still read (ps and sysctl by absolute path)`, async () => {
    const child = spawn(process.execPath, ["-e", `
      import { bootId, currentIdentity, procStart } from ${JSON.stringify(join(import.meta.dir, "proc.ts"))};
      console.log(JSON.stringify({ boot: bootId(), me: currentIdentity(), parent: procStart(${process.pid}) }));
    `], { env: { PATH }, stdio: ["ignore", "pipe", "inherit"] });
    const line = await createInterface({ input: child.stdout! })[Symbol.asyncIterator]().next();
    const seen = JSON.parse(String(line.value)) as { boot: string; me: { pid: number; procStart: string; bootId: string }; parent: string };
    expect(seen.boot).toBe(bootId());
    expect(seen.me.bootId).toBe(bootId());
    expect(seen.parent).toBe(currentIdentity().procStart);
    expect(seen.me.procStart).not.toBe("unknown");
  }, 20_000);
}

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
  expect(Math.abs(start - (Date.now() / 1000 - process.uptime()))).toBeLessThan(3); // timing-gap: not a duration: two readings of this process's start (ps, and the clock less the uptime) agree to within seconds
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
