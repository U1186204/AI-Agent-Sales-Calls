/**
 * Email/SMS providers.
 *
 * - Resend (email): POST https://api.resend.com/emails, Bearer auth, JSON body.
 * - Twilio (SMS):   POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json,
 *                   HTTP Basic auth (SID:token), form-encoded To/From/Body.
 * - Mock (both):    writes one JSON file per message to OUTBOX_DIR (default .data/outbox) and
 *                   logs a masked one-liner. The outbox is a local stand-in for a mailbox, so
 *                   it holds the full message; it lives under the gitignored .data/ folder.
 *
 * All network calls time out after 10 s and never throw: failures come back as `{ok:false}`.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/config/env";
import { logger, scrubLogText } from "@/guard/logger";
import { maskEmail, maskPhone } from "@/guard/redact";
import type {
  EmailMessage,
  EmailProvider,
  MessageMeta,
  ProviderResult,
  SmsMessage,
  SmsProvider,
} from "./types";

export const SEND_TIMEOUT_MS = 10_000;
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const twilioEndpoint = (sid: string) =>
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;

type FetchLike = typeof fetch;

/** Short, PII-free error string for logs and the Notification row. */
export function safeError(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg =
      err.name === "TimeoutError" || err.name === "AbortError" ? "timeout after 10s" : err.message;
  } else {
    msg = String(err);
  }
  return scrubLogText(msg).slice(0, 300);
}

async function readProviderError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    const m = body.message ?? body.error;
    if (typeof m === "string") detail = `: ${m}`;
  } catch {
    // ignore non-JSON bodies
  }
  return scrubLogText(`HTTP ${res.status}${detail}`).slice(0, 300);
}

export function createResendProvider(opts: {
  apiKey: string;
  from: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): EmailProvider {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<FetchLike>) => fetch(...a));
  return {
    name: "resend",
    async send(message: EmailMessage): Promise<ProviderResult> {
      try {
        const res = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: opts.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: await readProviderError(res) };
        const body = (await res.json().catch(() => ({}))) as { id?: unknown };
        return { ok: true, id: typeof body.id === "string" ? body.id : undefined };
      } catch (err) {
        return { ok: false, error: safeError(err) };
      }
    },
  };
}

export function createTwilioProvider(opts: {
  accountSid: string;
  authToken: string;
  from: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): SmsProvider {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<FetchLike>) => fetch(...a));
  const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`, "utf8").toString("base64");
  return {
    name: "twilio",
    async send(message: SmsMessage): Promise<ProviderResult> {
      try {
        const res = await doFetch(twilioEndpoint(opts.accountSid), {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: message.to,
            From: opts.from,
            Body: message.body,
          }).toString(),
          signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: await readProviderError(res) };
        const body = (await res.json().catch(() => ({}))) as { sid?: unknown };
        return { ok: true, id: typeof body.sid === "string" ? body.sid : undefined };
      } catch (err) {
        return { ok: false, error: safeError(err) };
      }
    },
  };
}

function outboxDir(dir?: string): string {
  const d = dir ?? getEnv().OUTBOX_DIR;
  // The outbox location is runtime config, not a build input: tell Turbopack not to trace it
  // (otherwise the whole project is traced into the server output).
  return path.isAbsolute(d) ? d : path.join(/* turbopackIgnore: true */ process.cwd(), d);
}

async function writeOutbox(
  dir: string,
  channel: "email" | "sms",
  meta: MessageMeta,
  content: Record<string, unknown>,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${stamp}-${channel}-${meta.audience}-${randomBytes(4).toString("hex")}.json`;
  await writeFile(
    path.join(dir, file),
    JSON.stringify(
      {
        channel,
        audience: meta.audience,
        businessId: meta.businessId,
        relatedRef: meta.relatedRef,
        createdAt: new Date().toISOString(),
        ...content,
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

export function createMockEmailProvider(opts: { dir?: string } = {}): EmailProvider {
  return {
    name: "mock",
    async send(message, meta) {
      try {
        const file = await writeOutbox(outboxDir(opts.dir), "email", meta, { ...message });
        logger.info("notify_mock_email", {
          to: maskEmail(message.to),
          audience: meta.audience,
          relatedRef: meta.relatedRef,
          file,
        });
        return { ok: true, id: file };
      } catch (err) {
        return { ok: false, error: safeError(err) };
      }
    },
  };
}

export function createMockSmsProvider(opts: { dir?: string } = {}): SmsProvider {
  return {
    name: "mock",
    async send(message, meta) {
      try {
        const file = await writeOutbox(outboxDir(opts.dir), "sms", meta, { ...message });
        logger.info("notify_mock_sms", {
          to: maskPhone(message.to),
          audience: meta.audience,
          relatedRef: meta.relatedRef,
          file,
        });
        return { ok: true, id: file };
      } catch (err) {
        return { ok: false, error: safeError(err) };
      }
    },
  };
}

/** Provider chosen from env: Resend/Twilio when configured, else mock. */
export function defaultEmailProvider(): EmailProvider {
  const env = getEnv();
  return env.RESEND_API_KEY
    ? createResendProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
    : createMockEmailProvider();
}

export function defaultSmsProvider(): SmsProvider {
  const env = getEnv();
  return env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM
    ? createTwilioProvider({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_FROM,
      })
    : createMockSmsProvider();
}
