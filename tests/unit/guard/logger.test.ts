import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/config/env";
import { createLogger, scrubLogText, setLogSink, withRequestLogger } from "@/guard/logger";

let lines: { line: string; level: string }[] = [];

beforeEach(() => {
  lines = [];
  setLogSink((line, level) => lines.push({ line, level }));
});
afterEach(() => {
  setLogSink();
  delete process.env.LOG_LEVEL;
  resetEnvCache();
});

describe("scrubLogText", () => {
  it("masks emails, phones, card-like numbers and SSNs", () => {
    const out = scrubLogText(
      "from jane.doe@example.com call +1 (317) 555-0199 or 3175550199 card 4111 1111 1111 1112 ssn 123-45-6789",
    );
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).toContain("j***@e***.com");
    expect(out).not.toMatch(/555-0199|5550199/);
    expect(out).toContain("***-***-0199");
    expect(out).toContain("[card-like number]");
    expect(out).toContain("[SSN]");
  });
  it("leaves ordinary text, references and ids alone", () => {
    const s = "order OAS-7K2M-Q9XD qty 3 took 120ms id cm1abc2345678901234";
    expect(scrubLogText(s)).toBe(s);
  });
});

describe("logger", () => {
  it("emits one JSON line with ts, level, reqId, msg and fields", () => {
    withRequestLogger("req-12345678", { route: "/api/chat" }).info("hello", { ms: 12 });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!.line);
    expect(rec).toMatchObject({
      level: "info",
      reqId: "req-12345678",
      msg: "hello",
      route: "/api/chat",
      ms: 12,
    });
    expect(typeof rec.ts).toBe("string");
  });

  it("never outputs PII in msg or nested fields", () => {
    const log = createLogger({ reqId: "r-00000001" });
    log.warn("customer jane@example.com said 4111111111111111", {
      customer: {
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        phone: "+13175550199",
        address1: "1 Elm St",
        zip: "46241",
      },
      text: "reach me at 317.555.0199",
      err: new Error("failed for jane@example.com"),
    });
    const raw = lines[0]!.line;
    for (const pii of [
      "jane@example.com",
      "Jane",
      "Doe",
      "3175550199",
      "317.555.0199",
      "1 Elm St",
      "46241",
      "4111111111111111",
    ]) {
      expect(raw).not.toContain(pii);
    }
    const rec = JSON.parse(raw);
    expect(rec.customer.zip).toBe("462**");
    expect(rec.err.message).toContain("j***@e***.com");
  });

  it("respects LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    resetEnvCache();
    const log = createLogger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => JSON.parse(l.line).msg)).toEqual(["w", "e"]);
  });

  it("silent disables output", () => {
    process.env.LOG_LEVEL = "silent";
    resetEnvCache();
    createLogger().error("x");
    expect(lines).toHaveLength(0);
  });

  it("child loggers merge fields and cannot override reserved keys", () => {
    createLogger({ reqId: "abc12345" })
      .child({ route: "/x" })
      .info("m", { level: "hack", msg: "hack" });
    const rec = JSON.parse(lines[0]!.line);
    expect(rec).toMatchObject({ level: "info", msg: "m", route: "/x", reqId: "abc12345" });
  });
});
