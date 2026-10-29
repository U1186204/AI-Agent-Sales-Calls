/**
 * Eval execution (loaded by evals/run.ts AFTER the env points at the eval DB): runs every case
 * with limited concurrency, prints a live line per case, writes docs/evals.md.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getEnv } from "@/config/env";
import { setLogSink } from "@/guard/logger";
import { ALL_CASES } from "./cases";
import { clip, Harness, initShared } from "./harness";
import type { AssertionResult, EvalCase } from "./types";

interface CaseResult {
  c: EvalCase;
  pass: boolean;
  turns: number;
  tools: string[];
  costMicros: number;
  ms: number;
  assertions: AssertionResult[];
  error?: string;
  notes: string[];
}

export async function main(opts: {
  dataDir: string;
  root: string;
  concurrency: number;
  filter?: string;
}): Promise<number> {
  const logFile = path.join(opts.dataDir, "eval-app.log");
  mkdirSync(opts.dataDir, { recursive: true });
  writeFileSync(logFile, "");
  setLogSink((line) => appendFileSync(logFile, `${line}\n`));

  const shared = initShared(opts.dataDir);
  const env = getEnv();
  const cases = opts.filter ? ALL_CASES.filter((c) => c.id.includes(opts.filter!)) : ALL_CASES;
  const started = Date.now();
  console.log(
    `Running ${cases.length} eval case(s) with ${env.OASIS_MODEL}, concurrency ${opts.concurrency}\n`,
  );

  const results: CaseResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++]!;
      const r = await runCase(c, shared);
      results.push(r);
      const status = r.pass ? "PASS" : "FAIL";
      const firstFail = r.error ?? r.assertions.find((a) => !a.pass)?.name;
      console.log(
        `${status}  ${c.id.padEnd(40)} ${c.business.padEnd(20)} ${String(r.turns).padStart(2)} turns  ${String(r.tools.length).padStart(2)} tools  $${(r.costMicros / 1e6).toFixed(4)}  ${(r.ms / 1000).toFixed(1)}s${firstFail && !r.pass ? `  ← ${clip(firstFail, 120)}` : ""}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  results.sort((a, b) => cases.indexOf(a.c) - cases.indexOf(b.c));

  const passed = results.filter((r) => r.pass).length;
  const cost = results.reduce((s, r) => s + r.costMicros, 0) / 1e6;
  const secs = (Date.now() - started) / 1000;
  console.log(
    `\n${passed}/${results.length} passed · total cost $${cost.toFixed(4)} · ${secs.toFixed(0)}s`,
  );

  if (!opts.filter) {
    writeReport(path.join(opts.root, "docs", "evals.md"), results, env.OASIS_MODEL, cost, secs);
    console.log("Wrote docs/evals.md");
  } else {
    console.log("(filtered run: docs/evals.md not written)");
  }
  await shared.prisma.$disconnect();
  setLogSink();
  return passed === results.length ? 0 : 1;
}

async function runCase(c: EvalCase, shared: ReturnType<typeof initShared>): Promise<CaseResult> {
  const h = new Harness(c, shared);
  const t0 = Date.now();
  let error: string | undefined;
  try {
    await c.run(h);
    h.finalizeAutoChecks();
  } catch (err) {
    error = `exception: ${(err as Error).message}`;
  }
  const tools = h.turns.flatMap((t) => t.toolCalls.map((x) => x.name));
  const pass = !error && h.results.length > 0 && h.results.every((a) => a.pass);
  if (!pass && process.env.EVAL_VERBOSE) {
    // Debug aid for filtered runs: failed assertions + the transcript (PII-free test data).
    const fails = h.results.filter((a) => !a.pass).map((a) => `  ✗ ${a.name} — ${a.detail ?? ""}`);
    const turns = h.turns.map(
      (t, i) =>
        `  [${i + 1}] ${t.kind === "event" ? "EVENT" : "USER"}: ${clip(t.input, 200)}\n      tools: ${t.toolCalls.map((x) => `${x.name}(${clip(JSON.stringify(x.input), 160)})`).join(", ") || "—"}\n      AI: ${clip(t.reply, 700)}`,
    );
    console.log(`--- ${c.id} ${error ?? ""}\n${fails.join("\n")}\n${turns.join("\n")}`);
  }
  return {
    c,
    pass,
    turns: h.turns.length,
    tools,
    costMicros: h.costMicros,
    ms: Date.now() - t0,
    assertions: h.results,
    error,
    notes: h.notes,
  };
}

const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function writeReport(
  file: string,
  results: CaseResult[],
  model: string,
  cost: number,
  secs: number,
): void {
  const passed = results.filter((r) => r.pass).length;
  const counts = (r: CaseResult) => {
    const by = (k: string) => r.assertions.filter((a) => a.kind === k).length;
    return `${by("tool")} tool · ${by("state")} state · ${by("text")} text · ${by("judge")} judge`;
  };
  const lines: string[] = [
    "# Oasis — LLM eval results",
    "",
    `- Date: ${new Date().toISOString()}`,
    `- Model: \`${model}\` (judge: same model, temperature 0)`,
    `- Result: **${passed}/${results.length} passed** (${results.length - passed} failed)`,
    `- Cost: $${cost.toFixed(4)} (agent + judge) · wall time ${secs.toFixed(0)} s`,
    "- Runner: `npm run eval` (fresh eval DB under `.data/eval/`, seeded; no retries — a flaky case is a failure)",
    "",
    "## Results",
    "",
    "| ID | Category | Business | Result | Turns | Tools used | Notes |",
    "|---|---|---|---|---|---|---|",
    ...results.map((r) => {
      const toolSet = [...new Set(r.tools)];
      const fails = r.assertions.filter((a) => !a.pass).length;
      const note = [
        `${r.assertions.length} assertions (${counts(r)})`,
        fails ? `${fails} failed` : "",
        r.error ? "exception" : "",
        ...r.notes,
      ]
        .filter(Boolean)
        .join("; ");
      return `| ${r.c.id} | ${r.c.category} | ${r.c.business} | ${r.pass ? "PASS" : "**FAIL**"} | ${r.turns} | ${md(toolSet.join(", ") || "—")} | ${md(note)} |`;
    }),
    "",
    "## Failure details",
    "",
  ];
  const failed = results.filter((r) => !r.pass);
  if (failed.length === 0) lines.push("None.");
  for (const r of failed) {
    lines.push(`### ${r.c.id} — ${md(r.c.title)}`, "");
    if (r.error) lines.push(`- ${md(r.error)}`);
    for (const a of r.assertions.filter((x) => !x.pass)) {
      lines.push(`- [${a.kind}] ${md(a.name)}${a.detail ? ` — ${md(clip(a.detail, 400))}` : ""}`);
    }
    lines.push("");
  }
  lines.push(
    "## Case catalogue",
    "",
    "| ID | Title | Assertions |",
    "|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.c.id} | ${md(r.c.title)} | ${md(r.assertions.map((a) => `${a.kind}: ${a.name}`).join("; "))} |`,
    ),
    "",
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"));
}
