"use client";

import { useState } from "react";
import { TEST_STUB_MODEL, type ChatUsage, type DataRef, type TraceStep } from "@/contracts";
import { formatInt, formatMs, humanizeKey } from "@/ui-lib/format";
import {
  IconAlert,
  IconBox,
  IconCalendar,
  IconCart,
  IconChevronRight,
  IconDoc,
  IconLock,
  IconMail,
  IconPin,
  IconSearch,
  IconShield,
  IconSpark,
  IconTag,
} from "../icons";

export interface TraceTurn {
  /** Assistant message id this trace belongs to. */
  id: string;
  index: number;
  /** What the customer asked (or the event), shown as context. */
  prompt: string;
  steps: TraceStep[];
  usage?: ChatUsage;
}

const TOOL_ICONS: Record<string, typeof IconSearch> = {
  search_catalog: IconSearch,
  get_product: IconTag,
  check_inventory: IconBox,
  quote_products: IconCart,
  list_services: IconDoc,
  quote_service: IconTag,
  check_availability: IconCalendar,
  check_service_area: IconPin,
  get_policies: IconDoc,
  start_checkout: IconLock,
  lookup_status: IconSearch,
  escalate_to_support: IconMail,
};

const REF_LABEL: Record<DataRef["type"], string> = {
  sku: "SKU",
  service: "Service",
  slot: "Slot",
  policy: "Policy",
  order: "Order",
  booking: "Booking",
  draft: "Checkout",
  zip: "ZIP",
  ticket: "Ticket",
};

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Chips shown before "+N more". */
const MAX_CHIPS = 5;
/** Internal references that mean nothing to a customer (raw checkout ids). */
const HIDDEN_REF_TYPES = new Set<DataRef["type"]>(["draft"]);
/** Looks like a database id (cuid / uuid), not something a person would read. */
const RAW_ID = /^(c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Empty values are left out of the "Looked up with" list entirely. */
function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}

/** Readable value for a key/value row, or null when it needs the JSON disclosure. */
function readable(v: unknown): string | null {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (isPrimitive(v)) return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "None";
    if (v.every(isPrimitive)) return v.join(", ");
    // Arrays of small flat objects, e.g. [{sku, qty}] → "SKU-1 × 2, SKU-2 × 1".
    if (
      v.every(
        (o) =>
          o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every(isPrimitive),
      )
    ) {
      return v
        .map((o) => {
          const rec = o as Record<string, string | number | boolean>;
          const vals = Object.entries(rec)
            .filter(([k]) => k !== "reason")
            .map(([k, val]) => (k === "qty" ? `× ${val}` : String(val)));
          return vals.join(" ");
        })
        .join(", ");
    }
    return null;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length <= 4 && entries.every(([, val]) => isPrimitive(val))) {
      return entries.map(([k, val]) => `${humanizeKey(k)}: ${String(val)}`).join(" · ");
    }
  }
  return null;
}

function Refs({ refs, more }: { refs: DataRef[]; more: number }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = refs.length > MAX_CHIPS;
  const shown = expanded || !collapsible ? refs : refs.slice(0, MAX_CHIPS);
  const hiddenHere = refs.length - shown.length;
  return (
    <ul className="trace-refs" role="list">
      {shown.map((r, i) => (
        <li key={`${r.type}-${r.id}-${i}`} className="chip">
          <span className="chip__type">{REF_LABEL[r.type]}</span>
          {r.id}
        </li>
      ))}
      {/* Refs the server already left out (moreRefs) can't be expanded: plain count. */}
      {more > 0 && (expanded || !collapsible) && <li className="chip chip--more">+{more} more</li>}
      {collapsible && (
        <li>
          <button
            type="button"
            className="chip chip--more chip--button"
            aria-expanded={expanded}
            onClick={() => setExpanded((x) => !x)}
          >
            {expanded ? "Show fewer" : `+${hiddenHere + more} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

function StepCard({ step }: { step: TraceStep }) {
  const Icon =
    step.kind === "guard"
      ? IconShield
      : step.kind === "model"
        ? IconSpark
        : !step.ok
          ? IconAlert
          : (TOOL_ICONS[step.tool ?? ""] ?? IconSpark);
  const entries = Object.entries(step.input ?? {}).filter(([k]) => k !== "reason");
  const rows = entries.filter(([, v]) => !isEmpty(v)).map(([k, v]) => ({ k, v: readable(v) }));
  const complex = rows.some((r) => r.v === null);
  const refs = step.dataRefs.filter((r) => !HIDDEN_REF_TYPES.has(r.type) && !RAW_ID.test(r.id));
  const moreRefs = step.moreRefs ?? 0;
  const showMs = Number.isFinite(step.ms) && step.ms > 0;

  return (
    <li className="trace-step" data-ok={step.ok} data-kind={step.kind}>
      <div className="trace-step__top">
        <span className="trace-step__icon">
          <Icon />
        </span>
        <div>
          <div className="trace-step__label">{step.label}</div>
          {step.kind !== "tool" && (
            <span className="badge">{step.kind === "guard" ? "Safety check" : "Model"}</span>
          )}
        </div>
        {showMs && (
          <span className="trace-step__ms">
            <span className="visually-hidden">Took </span>
            {formatMs(step.ms)}
          </span>
        )}
      </div>

      {step.why && step.kind !== "model" && (
        <p className="trace-step__why">
          <b>Why: </b>
          {step.why}
        </p>
      )}

      {rows.length > 0 && (
        <div>
          <div className="trace-step__section">Looked up with</div>
          <dl className="trace-kv">
            {rows.map(({ k, v }) => (
              <div className="trace-kv__row" key={k}>
                <dt>{humanizeKey(k)}</dt>
                <dd>{v ?? "See details below"}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div>
        <div className="trace-step__section">{step.ok ? "Result" : "Problem"}</div>
        <p className="trace-step__out">{step.outputSummary}</p>
        {step.error && <p className="trace-step__error">{step.error}</p>}
      </div>

      {(refs.length > 0 || moreRefs > 0) && (
        <div>
          <div className="trace-step__section">Data referenced</div>
          <Refs refs={refs} more={moreRefs} />
        </div>
      )}

      {(complex || entries.length > 0) && (
        <details className="details">
          <summary>
            <IconChevronRight />
            Technical details
          </summary>
          <pre>{JSON.stringify({ tool: step.tool, input: step.input ?? {} }, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}

function UsageLine({ usage }: { usage: ChatUsage }) {
  return (
    <p className="trace-usage">
      {usage.model === TEST_STUB_MODEL && (
        <span
          className="trace-testmode"
          title="OASIS_LLM_STUB=1: scripted test assistant, no AI model"
        >
          Test mode
        </span>
      )}
      <span>
        Model <b>{usage.model}</b>
      </span>
      <span>
        <b>{formatInt(usage.inputTokens)}</b> in / <b>{formatInt(usage.outputTokens)}</b> out tokens
      </span>
      <span>
        Cost <b>${usage.costUsd.toFixed(4)}</b>
      </span>
      {usage.toolRounds > 0 && (
        <span>
          <b>{usage.toolRounds}</b> tool round{usage.toolRounds === 1 ? "" : "s"}
        </span>
      )}
    </p>
  );
}

export function TracePanel({
  turns,
  highlightId,
  headingId,
}: {
  turns: TraceTurn[];
  highlightId?: string;
  headingId: string;
}) {
  const ordered = [...turns].reverse();
  return (
    <div className="trace">
      <div className="trace__head">
        <h2 id={headingId} className="trace__title">
          How the agent answered
        </h2>
        <p className="trace__intro">
          Every lookup behind each reply, newest first. Personal details are masked.
        </p>
      </div>

      {ordered.length === 0 ? (
        <div className="trace__empty">
          <p>After the agent replies, you&rsquo;ll see here:</p>
          <ul>
            <li>Which tools it used, like inventory, pricing or the calendar</li>
            <li>Why it used each one, in its own words</li>
            <li>What it looked up and what came back</li>
            <li>The SKUs, services and time slots it relied on</li>
            <li>The model, tokens and cost of the reply</li>
          </ul>
        </div>
      ) : (
        ordered.map((turn) => (
          <article
            key={turn.id}
            id={`trace-${turn.id}`}
            className="trace-group"
            data-highlight={highlightId === turn.id}
            tabIndex={-1}
            aria-label={`Reply ${turn.index}`}
          >
            <header className="trace-group__head">
              <span className="trace-group__label">Reply {turn.index}</span>
              <span className="trace-group__quote">{turn.prompt}</span>
            </header>
            {turn.steps.length === 0 ? (
              <p className="trace-group__none">
                Answered from the conversation so far. No lookups were needed.
              </p>
            ) : (
              <ol className="trace-steps" role="list">
                {turn.steps.map((s) => (
                  <StepCard key={s.id} step={s} />
                ))}
              </ol>
            )}
            {turn.usage && <UsageLine usage={turn.usage} />}
          </article>
        ))
      )}
    </div>
  );
}
