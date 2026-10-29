/** Scripted fake Anthropic client for runner tests (records every request it receives). */
import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "@/agent";
import type { NotificationRecord, NotifyDeps } from "@/notify";

export type Script = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  call: number,
) => Anthropic.Message;

let seq = 0;

export function message(
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input: Record<string, unknown>; id?: string }
  >,
  usage = { input_tokens: 1200, output_tokens: 80 },
): Anthropic.Message {
  const blocks = content.map((b) =>
    b.type === "text"
      ? { type: "text", text: b.text, citations: null }
      : { type: "tool_use", id: b.id ?? `toolu_fake_${++seq}`, name: b.name, input: b.input },
  );
  return {
    id: `msg_fake_${++seq}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: blocks,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      ...usage,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

export const text = (t: string) => message([{ type: "text", text: t }]);
export const toolUse = (name: string, input: Record<string, unknown>, id?: string) =>
  message([{ type: "tool_use", name, input, id }]);

export interface FakeClient extends LlmClient {
  calls: Anthropic.MessageCreateParamsNonStreaming[];
}

/** Each call uses the next script entry; the last entry repeats. */
export function fakeClient(...script: Array<Anthropic.Message | Script | Error>): FakeClient {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    async createMessage(params) {
      // Snapshot: the runner mutates its messages array after the call.
      calls.push(JSON.parse(JSON.stringify(params)) as Anthropic.MessageCreateParamsNonStreaming);
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      if (step instanceof Error) throw step;
      if (typeof step === "function") return step(params, calls.length);
      if (!step) throw new Error("fake client: empty script");
      return step;
    },
  };
}

/** Notification deps that never touch the app DB or disk. */
export function fakeNotify(): NotifyDeps & { rows: NotificationRecord[]; sent: string[] } {
  const rows: NotificationRecord[] = [];
  const sent: string[] = [];
  return {
    rows,
    sent,
    email: {
      name: "mock",
      async send(m) {
        sent.push(m.subject);
        return { ok: true, id: "mock-1" };
      },
    },
    sms: {
      name: "mock",
      async send() {
        sent.push("sms");
        return { ok: true, id: "mock-sms" };
      },
    },
    store: {
      async record(row) {
        rows.push(row);
        return { id: `n${rows.length}` };
      },
    },
  };
}
