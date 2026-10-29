import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/config/env";
import { setLogSink } from "@/guard/logger";
import {
  dispatchCheckoutNotifications,
  sendEscalationEmail,
  type CheckoutNotificationPayload,
  type NotificationRecord,
  type NotificationStore,
} from "@/notify";
import {
  createMockEmailProvider,
  createMockSmsProvider,
  createResendProvider,
  createTwilioProvider,
  defaultEmailProvider,
  defaultSmsProvider,
} from "@/notify/providers";
import {
  businessNewCheckoutEmail,
  businessSms,
  customerConfirmationEmail,
  escapeHtml,
  escalationEmail,
  formatCents,
} from "@/notify/templates";

const payload: CheckoutNotificationPayload = {
  kind: "order",
  businessId: "volt-supply",
  businessName: "Volt & Wire Electrical Supply",
  reference: "OAS-7K2M-Q9XD",
  customer: {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@example.com",
    phoneE164: "+13175550199",
  },
  business: {
    notifyEmail: "orders@volt.example",
    notifyPhone: "+13175550100",
    supportEmail: "help@volt.example",
  },
  lines: [
    { label: "14 AWG THHN wire, 500 ft", qty: 2, amountCents: 17998 },
    { label: "Wire nuts <b>bulk</b>", qty: 1, amountCents: 1299 },
  ],
  subtotalCents: 19297,
  shippingCents: 1250,
  taxCents: 1447,
  totalCents: 21994,
  addressLabel: "123 Main St, Springfield, IL 62704",
  instructions: "Leave at the side door",
};

function memoryStore() {
  const rows: NotificationRecord[] = [];
  const store: NotificationStore = {
    record: async (row) => {
      rows.push(row);
      return { id: `n${rows.length}` };
    },
  };
  return { rows, store };
}

let dir: string;
let logs: string[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "oasis-outbox-"));
  logs = [];
  setLogSink((l) => logs.push(l));
});
afterEach(async () => {
  setLogSink();
  vi.unstubAllGlobals();
  for (const k of ["RESEND_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"])
    delete process.env[k];
  resetEnvCache();
  await rm(dir, { recursive: true, force: true });
});

describe("dispatchCheckoutNotifications (mock)", () => {
  it("writes an outbox file per message and a masked Notification row per send", async () => {
    const { rows, store } = memoryStore();
    const res = await dispatchCheckoutNotifications(payload, {
      email: createMockEmailProvider({ dir }),
      sms: createMockSmsProvider({ dir }),
      store,
      appUrl: "http://localhost:3000",
    });

    expect(res.customerEmail).toMatchObject({
      status: "mocked",
      provider: "mock",
      toMasked: "j***@e***.com",
      notificationId: expect.any(String),
    });
    expect(res.businessEmail).toMatchObject({ status: "mocked", toMasked: "o***@v***.example" });
    expect(res.businessSms).toMatchObject({
      status: "mocked",
      channel: "sms",
      toMasked: "***-***-0100",
    });

    const files = await readdir(dir);
    expect(files).toHaveLength(3);
    const sms = JSON.parse(
      await readFile(
        path.join(
          dir,
          files.find((f) => f.includes("-sms-"))!,
        ),
        "utf8",
      ),
    );
    expect(sms.to).toBe("+13175550100");
    expect(sms.body).toContain("OAS-7K2M-Q9XD");
    expect(sms.body).toContain("Jane D.");
    expect(sms.body).not.toContain("Doe");
    expect(sms.body).not.toContain("Main St");

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => `${r.channel}/${r.audience}/${r.provider}/${r.status}`).sort()).toEqual([
      "email/business/mock/mocked",
      "email/customer/mock/mocked",
      "sms/business/mock/mocked",
    ]);
    const serializedRows = JSON.stringify(rows);
    for (const pii of [
      "jane.doe@example.com",
      "+13175550199",
      "+13175550100",
      "orders@volt.example",
      "Main St",
      "Doe",
    ]) {
      expect(serializedRows).not.toContain(pii);
    }
    expect(
      rows.every((r) => r.relatedRef === "OAS-7K2M-Q9XD" && r.businessId === "volt-supply"),
    ).toBe(true);
    // masked one-liner logs only
    const logText = logs.join("\n");
    expect(logText).toContain("notify_mock_email");
    expect(logText).not.toContain("jane.doe@example.com");
    expect(logText).not.toContain("3175550100");
  });

  it("skips business SMS when no notify phone is configured", async () => {
    const { rows, store } = memoryStore();
    const res = await dispatchCheckoutNotifications(
      { ...payload, business: { ...payload.business, notifyPhone: null } },
      { email: createMockEmailProvider({ dir }), sms: createMockSmsProvider({ dir }), store },
    );
    expect(res.businessSms.status).toBe("skipped");
    expect(rows).toHaveLength(2);
  });

  it("never throws: provider failures and store failures become results", async () => {
    const failing = {
      name: "resend" as const,
      send: vi.fn().mockRejectedValue(new Error("boom for jane.doe@example.com")),
    };
    const badStore: NotificationStore = { record: vi.fn().mockRejectedValue(new Error("db down")) };
    const res = await dispatchCheckoutNotifications(payload, {
      email: failing,
      sms: createMockSmsProvider({ dir }),
      store: badStore,
    });
    expect(res.customerEmail.status).toBe("failed");
    expect(res.customerEmail.error).not.toContain("jane.doe@example.com");
    expect(res.businessSms.status).toBe("mocked");
    expect(res.businessSms.notificationId).toBeUndefined();
  });

  it("invalid payload → failed results, no throw", async () => {
    const res = await dispatchCheckoutNotifications({ ...payload, lines: [] });
    expect(res.customerEmail.status).toBe("failed");
    expect(res.businessSms.status).toBe("failed");
  });

  it("records provider failures with the error and status failed", async () => {
    const { rows, store } = memoryStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: "invalid to" }), { status: 422 }));
    const res = await sendEscalationEmail(
      {
        businessId: "volt-supply",
        businessName: "Volt",
        supportEmail: "help@volt.example",
        ticketRef: "ESC-1",
        reason: "requested_human",
        summary: "Wants a human",
      },
      {
        email: createResendProvider({ apiKey: "re_test", from: "Oasis <a@b.co>", fetchImpl }),
        store,
      },
    );
    expect(res).toMatchObject({ status: "failed", provider: "resend", audience: "support" });
    expect(rows[0]).toMatchObject({
      status: "failed",
      error: "HTTP 422: invalid to",
      audience: "support",
      relatedRef: "ESC-1",
    });
  });
});

describe("providers", () => {
  it("Resend request shape", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "em_123" }), { status: 200 }));
    const p = createResendProvider({
      apiKey: "re_key",
      from: "Oasis <onboarding@resend.dev>",
      fetchImpl,
    });
    const r = await p.send(
      { to: "jane@example.com", subject: "Hi", text: "t", html: "<p>h</p>", replyTo: "help@x.co" },
      { businessId: "b", audience: "customer" },
    );
    expect(r).toEqual({ ok: true, id: "em_123" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      from: "Oasis <onboarding@resend.dev>",
      to: ["jane@example.com"],
      subject: "Hi",
      html: "<p>h</p>",
      text: "t",
      reply_to: "help@x.co",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("Twilio request shape (Basic auth, form-encoded)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }));
    const p = createTwilioProvider({
      accountSid: "AC123",
      authToken: "tok",
      from: "+15005550006",
      fetchImpl,
    });
    const r = await p.send(
      { to: "+13175550100", body: "New order OAS-1" },
      { businessId: "b", audience: "business" },
    );
    expect(r).toEqual({ ok: true, id: "SM123" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("AC123:tok").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const form = new URLSearchParams(init.body);
    expect(Object.fromEntries(form)).toEqual({
      To: "+13175550100",
      From: "+15005550006",
      Body: "New order OAS-1",
    });
  });

  it("timeouts and network errors return ok:false", async () => {
    const timeoutErr = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const p = createTwilioProvider({
      accountSid: "AC1",
      authToken: "t",
      from: "+1",
      fetchImpl: vi.fn().mockRejectedValue(timeoutErr),
    });
    expect(
      await p.send({ to: "+1", body: "x" }, { businessId: "b", audience: "business" }),
    ).toEqual({ ok: false, error: "timeout after 10s" });
  });

  it("really times out a hung request", async () => {
    const hung = vi.fn(
      (_u: unknown, init: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init.signal!.addEventListener("abort", () => rej(init.signal!.reason)),
        ),
    );
    const p = createResendProvider({
      apiKey: "k",
      from: "f",
      fetchImpl: hung as unknown as typeof fetch,
      timeoutMs: 20,
    });
    const r = await p.send(
      { to: "a@b.co", subject: "s", text: "t", html: "h" },
      { businessId: "b", audience: "customer" },
    );
    expect(r).toEqual({ ok: false, error: "timeout after 10s" });
  });

  it("selects real providers only when keys are configured", () => {
    expect(defaultEmailProvider().name).toBe("mock");
    expect(defaultSmsProvider().name).toBe("mock");
    process.env.RESEND_API_KEY = "re_x";
    process.env.TWILIO_ACCOUNT_SID = "AC1";
    process.env.TWILIO_AUTH_TOKEN = "t";
    resetEnvCache();
    expect(defaultEmailProvider().name).toBe("resend");
    expect(defaultSmsProvider().name).toBe("mock"); // TWILIO_FROM missing
    process.env.TWILIO_FROM = "+15005550006";
    resetEnvCache();
    expect(defaultSmsProvider().name).toBe("twilio");
  });
});

describe("templates", () => {
  it("escapeHtml", () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe(
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
    );
  });
  it("formatCents", () => {
    expect(formatCents(21994)).toBe("$219.94");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(5)).toBe("$0.05");
  });
  it("escapes all interpolated values in HTML", () => {
    const evil = {
      ...payload,
      businessName: `<script>alert(1)</script>`,
      customer: { ...payload.customer, firstName: `"><img src=x onerror=alert(1)>` },
    };
    const msg = customerConfirmationEmail(evil, "http://localhost:3000");
    expect(msg.html).not.toContain("<script>alert(1)</script>");
    expect(msg.html).not.toContain("<img src=x");
    expect(msg.html).toContain("&lt;script&gt;");
    expect(msg.html).toContain("Wire nuts &lt;b&gt;bulk&lt;/b&gt;");
    expect(msg.text).toContain("Wire nuts <b>bulk</b>"); // plain text stays literal
    expect(msg.html).toContain('lang="en"');
  });
  it("customer email includes reference, totals, status link", () => {
    const msg = customerConfirmationEmail(payload, "http://localhost:3000/");
    expect(msg.subject).toBe(
      "Your Volt & Wire Electrical Supply order is confirmed — OAS-7K2M-Q9XD",
    );
    expect(msg.text).toContain("Total: $219.94");
    expect(msg.text).toContain("Shipping: $12.50");
    expect(msg.text).toContain("http://localhost:3000/status");
  });
  it("booking SMS includes time and duration, no address", () => {
    const booking: CheckoutNotificationPayload = {
      ...payload,
      kind: "booking",
      businessId: "mountpro-tv",
      businessName: "MountPro TV Installation",
      shippingCents: 0,
      appointment: { localDateTimeLabel: "Tue, Oct 7, 9:00 AM EDT", durationMin: 150 },
    };
    const sms = businessSms(booking);
    expect(sms).toBe(
      "MountPro: New booking OAS-7K2M-Q9XD — Jane D., Tue, Oct 7, 9:00 AM EDT (2 hr 30 min), $219.94. Details in email.",
    );
    expect(sms).not.toContain("Main St");
  });
  it("WF-5 + SEC-12: business email names the business; the stored subject has no customer name", () => {
    const msg = businessNewCheckoutEmail(payload);
    expect(msg.subject).toBe("New order OAS-7K2M-Q9XD for Volt & Wire Electrical Supply — $219.94");
    expect(msg.subject).not.toMatch(/Jane|Doe|D\./);
    expect(msg.text).toContain("New order for Volt & Wire Electrical Supply");
    expect(businessSms(payload)).toMatch(/^Volt & Wire: New order OAS-7K2M-Q9XD/);
  });
  it("subjects cannot carry newlines", () => {
    const msg = customerConfirmationEmail(
      { ...payload, businessName: "A\r\nBcc: x@y.z" },
      "http://x",
    );
    expect(msg.subject).not.toMatch(/[\r\n]/);
  });
  it("escalation email redacts card numbers, shows contact only when provided", () => {
    const base = {
      businessId: "b",
      businessName: "Volt",
      supportEmail: "s@v.co",
      ticketRef: "ESC-9",
      reason: "frustration",
      summary: "Card 4111 1111 1111 1111 was declined <b>twice</b>",
    };
    const a = escalationEmail(base);
    expect(a.text).toContain("[card number removed]");
    expect(a.html).toContain("&lt;b&gt;twice&lt;/b&gt;");
    expect(a.replyTo).toBeUndefined();
    expect(a.text).toContain("did not leave a contact email");
    expect(a.text).toContain("Escalations");
    // INJ-5: emails / phones typed into the summary never reach support
    const c = escalationEmail({
      ...base,
      summary: "Call me at 512-555-0123 or mail jane@example.com please",
    });
    expect(c.text).not.toMatch(/512-555-0123|jane@example\.com/);
    expect(c.text).toContain("[phone removed]");
    expect(c.text).toContain("[email removed]");
    const b = escalationEmail({ ...base, contactEmail: "jane@example.com" });
    expect(b.replyTo).toBe("jane@example.com");
    expect(b.text).toContain("jane@example.com");
  });
});
