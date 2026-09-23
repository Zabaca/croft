import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
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
