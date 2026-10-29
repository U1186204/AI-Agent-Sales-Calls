/** POST /api/chat: validation, business binding, rate limits, fallback without a key. */
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PEER_HEADER, peerHeaderValue } from "@/guard/peer-address";
import { POST } from "@/app/api/chat/route";
import { ChatResponse } from "@/contracts";
import { resetEnvCache } from "@/config/env";
import { createConversation, getConversation } from "@/domain";
import { setLogSink } from "@/guard/logger";
import { resetRateLimits } from "@/guard/rate-limit";
import { setupTestDb, type TestDb } from "../domain/support/test-db";

const BASE = "http://localhost:3000";
let t: TestDb;
let logs: string[] = [];
const saved: Record<string, string | undefined> = {};
const KEYS = [
  "ANTHROPIC_API_KEY",
  "RATE_LIMIT_IP_PER_10MIN",
  "OASIS_MAX_TURNS",
  "OUTBOX_DIR",
  "RATE_LIMIT_ESCALATION_PER_HOUR",
  "RATE_LIMIT_ESCALATION_GLOBAL_PER_HOUR",
];

beforeAll(async () => {
  t = await setupTestDb("agent-route");
}, 120_000);
afterAll(async () => {
  await t?.cleanup();
});
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OUTBOX_DIR = path.join(tmpdir(), "oasis-route-outbox");
  resetEnvCache();
  resetRateLimits();
  logs = [];
  setLogSink((l) => logs.push(l));
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
  resetRateLimits();
  setLogSink();
});

function chatReq(body: unknown, ip = "203.0.113.9") {
  return new NextRequest(`${BASE}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      [PEER_HEADER]: peerHeaderValue(ip),
      "x-request-id": "req-chat-test-001",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/chat", () => {
  it("400 on malformed JSON and on invalid bodies", async () => {
    for (const b of [
      "{nope",
      {},
      { businessId: "nope", message: "hi" },
      { businessId: "volt-supply" },
      { businessId: "volt-supply", message: "   " },
    ]) {
      const res = await POST(chatReq(b));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
      expect(res.headers.get("x-request-id")).toBe("req-chat-test-001");
    }
  });

  it("400 input_too_long over OASIS_MAX_INPUT_CHARS", async () => {
    const res = await POST(chatReq({ businessId: "volt-supply", message: "x".repeat(2001) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("input_too_long");
  });

  it("creates a conversation and returns a fallback ChatResponse when no API key is set", async () => {
    const res = await POST(
      chatReq({ businessId: "volt-supply", message: "Hi, my card is 4111 1111 1111 1111" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-chat-test-001");
    const body = ChatResponse.parse(await res.json());
    expect(body).toMatchObject({
      fallback: true,
      offerEscalation: true,
      error: { code: "llm_unconfigured" },
    });
    const conv = await getConversation(body.conversationId, { withMessages: true });
    expect(conv?.businessId).toBe("volt-supply");
    expect(JSON.stringify(conv?.messages)).not.toContain("4111");
    expect(body.trace.some((s) => s.label === "Removed sensitive data")).toBe(true);
    const line = logs.find((l) => l.includes('"chat_turn"'));
    expect(line).toBeTruthy();
    expect(line).not.toContain("4111");
  });

  it("rejects switching an existing conversation to another business (403) and unknown ids (404)", async () => {
    const c = await createConversation("volt-supply");
    const res = await POST(
      chatReq({ businessId: "flowline-plumbing", conversationId: c.id, message: "hi" }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("invalid_request");
    expect((await getConversation(c.id, { withMessages: true }))!.messages).toHaveLength(0);

    const res2 = await POST(
      chatReq({ businessId: "volt-supply", conversationId: "does-not-exist", message: "hi" }),
    );
    expect(res2.status).toBe(404);
    expect((await res2.json()).error.code).toBe("not_found");
  });

  it("429 with a friendly message when the per-IP chat limit is exceeded", async () => {
    process.env.RATE_LIMIT_IP_PER_10MIN = "1";
    resetEnvCache();
    resetRateLimits();
    expect(
      (await POST(chatReq({ businessId: "volt-supply", message: "one" }, "198.51.100.7"))).status,
    ).toBe(200);
    const res = await POST(chatReq({ businessId: "volt-supply", message: "two" }, "198.51.100.7"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    const body = await res.json();
    expect(body.message).toMatch(/too quickly/);
  });

  it("429 session_limit when a conversation exceeds OASIS_MAX_TURNS", async () => {
    process.env.OASIS_MAX_TURNS = "1";
    resetEnvCache();
    resetRateLimits();
    const c = await createConversation("volt-supply");
    expect(
      (await POST(chatReq({ businessId: "volt-supply", conversationId: c.id, message: "a" })))
        .status,
    ).toBe(200);
    const res = await POST(
      chatReq({ businessId: "volt-supply", conversationId: c.id, message: "b" }),
    );
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("session_limit");
  });
});

describe("POST /api/chat hardening", () => {
  it("ADV-5: any over-long message is input_too_long (also > 20,000 chars and after NFKC growth)", async () => {
    const huge = await POST(chatReq({ businessId: "volt-supply", message: "x".repeat(20_001) }));
    expect(huge.status).toBe(400);
    expect((await huge.json()).error.code).toBe("input_too_long");
    // 1,000 × U+FDFA passes the raw length check but expands to ~18k chars under NFKC
    const grows = await POST(chatReq({ businessId: "volt-supply", message: "ﷺ".repeat(1000) }));
    expect(grows.status).toBe(400);
    expect((await grows.json()).error.code).toBe("input_too_long");
  });

  it("SEC-5: a body over 64 KB is refused with 413 before parsing", async () => {
    const res = await POST(
      chatReq(
        JSON.stringify({ businessId: "volt-supply", message: "hi", junk: "x".repeat(70_000) }),
      ),
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("input_too_long");
  });

  it("checkout events need their conversation (400)", async () => {
    const res = await POST(
      chatReq({ businessId: "volt-supply", event: { type: "checkout_cancelled", draftId: "abc" } }),
    );
    expect(res.status).toBe(400);
  });

  it("WF-1: request_human works without an LLM key and even after the message cap", async () => {
    process.env.OASIS_MAX_TURNS = "1";
    resetEnvCache();
    resetRateLimits();
    const c = await createConversation("greenstripe-lawn");
    await POST(chatReq({ businessId: "greenstripe-lawn", conversationId: c.id, message: "a" }));
    const res = await POST(
      chatReq({
        businessId: "greenstripe-lawn",
        conversationId: c.id,
        event: {
          type: "request_human",
          note: "Please call me back",
          contactEmail: "Jane@Example.com",
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = ChatResponse.parse(await res.json());
    expect(body.fallback).toBe(false);
    expect(body.blocks[0]).toMatchObject({ type: "text" });
    const textBlock = body.blocks[0] as { text: string };
    expect(textBlock.text).toMatch(/ESC-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(textBlock.text).toContain("support@greenstripe-lawn.example.com");
    expect(textBlock.text).toContain("within 1 business day");
    expect(body.trace[0]?.label).toBe("Escalated to a person");
    expect((await getConversation(c.id))?.outcome).toBe("escalated");
    expect(logs.join("\n")).not.toMatch(/jane@example\.com/i);
    // a request_human without a conversation starts one
    const fresh = await POST(
      chatReq({ businessId: "volt-supply", event: { type: "request_human" } }),
    );
    expect(fresh.status).toBe(200);
  });

  it("request_human validates its optional fields", async () => {
    const bad = await POST(
      chatReq({
        businessId: "volt-supply",
        event: { type: "request_human", contactEmail: "nope" },
      }),
    );
    expect(bad.status).toBe(400);
    const long = await POST(
      chatReq({
        businessId: "volt-supply",
        event: { type: "request_human", note: "x".repeat(501) },
      }),
    );
    expect(long.status).toBe(400);
  });
});

describe("POST /api/chat caps (R2-2, R2-4)", () => {
  const human = (ip: string, conversationId?: string, businessId = "greenstripe-lawn") =>
    POST(
      chatReq(
        {
          businessId,
          ...(conversationId ? { conversationId } : {}),
          event: { type: "request_human" },
        },
        ip,
      ),
    );
  const escalations = (businessId: string) => t.prisma.escalation.count({ where: { businessId } });

  it("R2-4: OASIS_MAX_TURNS = N accepts exactly N user messages, counting the first", async () => {
    process.env.OASIS_MAX_TURNS = "2";
    resetEnvCache();
    resetRateLimits();
    const first = await POST(chatReq({ businessId: "volt-supply", message: "one" }));
    expect(first.status).toBe(200);
    const { conversationId } = ChatResponse.parse(await first.json());
    const send = (message: string) =>
      POST(chatReq({ businessId: "volt-supply", conversationId, message }));
    expect((await send("two")).status).toBe(200);
    const third = await send("three");
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe("session_limit");
  });

  it("R2-2: request_human without a conversation opens one bound to the business", async () => {
    const res = await human("192.0.2.40", undefined, "mountpro-tv");
    expect(res.status).toBe(200);
    const body = ChatResponse.parse(await res.json());
    expect((await getConversation(body.conversationId))?.businessId).toBe("mountpro-tv");
    // the follow-up click in that conversation is deduplicated: same ticket, no new row
    const before = await escalations("mountpro-tv");
    const again = ChatResponse.parse(
      await (await human("192.0.2.40", body.conversationId, "mountpro-tv")).json(),
    );
    expect((again.blocks[0] as { text: string }).text).toMatch(/already in line/);
    expect(await escalations("mountpro-tv")).toBe(before);
  });

  it("R2-2: at most 3 new tickets per IP per hour → friendly 429 that names the support email", async () => {
    const before = await escalations("greenstripe-lawn");
    const codes: number[] = [];
    let firstConv = "";
    for (let i = 0; i < 5; i++) {
      const res = await human("198.51.100.40");
      codes.push(res.status);
      const body = await res.json();
      if (i === 0) firstConv = body.conversationId;
      if (res.status === 429) {
        expect(body.error.code).toBe("escalation_limited");
        expect(body.error.message).toContain("support@greenstripe-lawn.example.com");
        expect(res.headers.get("retry-after")).toBeTruthy();
      }
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(await escalations("greenstripe-lawn")).toBe(before + 3);
    // a repeat click for an already-open ticket is still answered (deduplicated, no email)
    expect((await human("198.51.100.40", firstConv)).status).toBe(200);
    expect(await escalations("greenstripe-lawn")).toBe(before + 3);
    // another client is unaffected
    expect((await human("198.51.100.41")).status).toBe(200);
    expect(logs.some((l) => l.includes('"escalation_rate_limited"'))).toBe(true);
  });

  it("R2-2: a per-business cap bounds new tickets across all clients", async () => {
    process.env.RATE_LIMIT_ESCALATION_GLOBAL_PER_HOUR = "2";
    resetEnvCache();
    resetRateLimits();
    expect((await human("203.0.113.61", undefined, "flowline-plumbing")).status).toBe(200);
    expect((await human("203.0.113.62", undefined, "flowline-plumbing")).status).toBe(200);
    const capped = await human("203.0.113.63", undefined, "flowline-plumbing");
    expect(capped.status).toBe(429);
    expect((await capped.json()).error.message).toContain("support@flowline-plumbing.example.com");
    // other businesses' inboxes have their own cap
    expect((await human("203.0.113.63", undefined, "volt-supply")).status).toBe(200);
  });
});
