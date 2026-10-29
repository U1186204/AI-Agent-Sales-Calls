/**
 * Trace-step builders shared by the model loop (runner.ts) and the LLM-free card actions
 * (card-actions.ts). Every value is PII-scrubbed before it reaches the transparency panel.
 */
import "server-only";
import { TOOL_NAMES, TOOL_SCHEMAS, type ToolName, type TraceStep } from "@/contracts";
import { scrubLogText, scrubValue } from "@/guard/logger";
import { dataRefsFor, summarizeToolOutput, traceInput, type ToolExecution } from "./tools";

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Real elapsed milliseconds since `t0` (performance.now), at least 1. */
export function elapsedMs(t0: number): number {
  return Math.max(1, Math.round(performance.now() - t0));
}

export function guardStep(
  id: string,
  label: string,
  why: string,
  outputSummary: string,
  ok = true,
  error?: string,
  ms = 1,
): TraceStep {
  return {
    id,
    kind: "guard",
    label,
    why,
    outputSummary,
    dataRefs: [],
    ok,
    ms: Math.max(1, Math.round(ms)),
    ...(error ? { error } : {}),
  };
}

const isTool = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

export function toolStep(id: string, name: string, exec: ToolExecution, ms: number): TraceStep {
  const { reason, ...rest } = exec.input as { reason?: unknown } & Record<string, unknown>;
  const label = isTool(name) ? TOOL_SCHEMAS[name].label : `Unknown tool ${name}`;
  const { refs, moreRefs } = dataRefsFor(name, exec.input, exec.output);
  return {
    id,
    kind: "tool",
    ...(isTool(name) ? { tool: name } : {}),
    label,
    why: scrubLogText(
      typeof reason === "string" && reason.trim() ? clip(reason.trim(), 200) : label,
    ),
    input: scrubValue(traceInput(rest)) as Record<string, unknown>,
    outputSummary: scrubLogText(summarizeToolOutput(name, exec)),
    dataRefs: refs,
    ...(moreRefs > 0 ? { moreRefs } : {}),
    ok: exec.ok,
    ...(exec.error ? { error: exec.error } : {}),
    ms: Math.max(1, ms),
  };
}
