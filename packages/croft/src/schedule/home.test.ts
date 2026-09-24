import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { croftHome, DEFAULT_JOB_LABEL } from "./home.ts";
import { realRunner } from "./os.ts";

describe("croftHome", () => {
  test("defaults to ~/.croft and dev.croft.tick", () => {
    const h = croftHome({ HOME: "/Users/ada" });
    expect(h).toEqual({
      dir: "/Users/ada/.croft", registry: "/Users/ada/.croft/projects.json", tickScript: "/Users/ada/.croft/tick.ts",
      logDir: "/Users/ada/.croft/logs", tickLog: "/Users/ada/.croft/logs/tick.log", jobLabel: DEFAULT_JOB_LABEL, userHome: "/Users/ada",
    });
  });

  test("CROFT_HOME and CROFT_JOB_LABEL override both", () => {
    const h = croftHome({ HOME: "/Users/ada", CROFT_HOME: "/tmp/x", CROFT_JOB_LABEL: "dev.croft.test-1" });
    expect(h.dir).toBe("/tmp/x");
    expect(h.tickLog).toBe(join("/tmp/x", "logs", "tick.log"));
    expect(h.jobLabel).toBe("dev.croft.test-1");
    expect(h.userHome).toBe("/Users/ada");
  });
});

describe("realRunner", () => {
  test("refuses every command under CROFT_FORBID_OS_JOBS=1 (tests/preload.ts sets it)", () => {
    expect(process.env.CROFT_FORBID_OS_JOBS).toBe("1");
    expect(() => realRunner().exec(["launchctl", "list"])).toThrow(/CROFT_FORBID_OS_JOBS/);
    expect(() => realRunner().exec(["/usr/bin/crontab", "-l"])).toThrow(/CROFT_FORBID_OS_JOBS/);
  });

  test("refuses commands that are not the scheduler's", () => {
    expect(() => realRunner({ PATH: "/usr/bin:/bin" }).exec(["rm", "-rf", "/tmp/nothing"])).toThrow(/not a scheduler command/);
  });
});
