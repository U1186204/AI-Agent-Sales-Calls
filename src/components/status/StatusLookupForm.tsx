"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { StatusLookup, type LookupStatusOutput } from "@/contracts";
import { lookupStatus } from "@/ui-lib/api";
import { formatCents, formatDateTimeZoned } from "@/ui-lib/format";
import { IconAlert, IconCheck } from "../icons";
import type { z } from "zod";

type Result = z.infer<typeof LookupStatusOutput>;
type Found = Extract<Result, { found: true }>;
type Field = "reference" | "email";

const NOT_FOUND =
  "We couldn't find an order or booking with that reference and email. Check both and try again.";

/** `desc` once the step is reached; `todo` while it is still ahead (VIS-11). */
const PRODUCT_STEPS = [
  { key: "confirmed", label: "Order confirmed", desc: "We have your order.", todo: "" },
  {
    key: "processing",
    label: "Processing",
    desc: "Picking and packing at our Indianapolis warehouse.",
    todo: "We'll pick and pack it at our Indianapolis warehouse.",
  },
  {
    key: "shipped",
    label: "Shipped",
    desc: "On its way by ground.",
    todo: "We'll email you when it ships by ground.",
  },
  {
    key: "delivered",
    label: "Delivered",
    desc: "Dropped off at your address.",
    todo: "It will be dropped off at your address.",
  },
];
const SERVICE_STEPS = [
  {
    key: "confirmed",
    label: "Booking confirmed",
    desc: "Your appointment is reserved.",
    todo: "",
  },
  {
    key: "completed",
    label: "Job completed",
    desc: "The work is done.",
    todo: "We'll mark it done after the visit.",
  },
];

function Timeline({ r }: { r: Found }) {
  const steps = r.kind === "product" ? PRODUCT_STEPS : SERVICE_STEPS;
  const idx = steps.findIndex((s) => s.key === r.status);
  return (
    <ol className="timeline" aria-label="Progress">
      {steps.map((s, i) => {
        const state =
          idx === -1
            ? "todo"
            : i < idx
              ? "done"
              : i === idx
                ? i === steps.length - 1
                  ? "done"
                  : "current"
                : "todo";
        return (
          <li key={s.key} className="timeline__item" data-state={state}>
            <span className="timeline__dot" aria-hidden="true">
              {state === "done" && <IconCheck />}
            </span>
            <div>
              <p className="timeline__label">
                {s.label}
                <span className="visually-hidden">
                  {state === "done"
                    ? " (done)"
                    : state === "current"
                      ? " (current step)"
                      : " (upcoming)"}
                </span>
              </p>
              <p className="timeline__desc">
                {s.key === "confirmed"
                  ? `${s.desc} ${formatDateTimeZoned(r.createdAt)}.`
                  : state === "todo"
                    ? s.todo
                    : s.desc}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * What was ordered/booked. Uses the server's display fields (`serviceName`, `itemsLabel`)
 * when present instead of raw codes or "item(s)" (VIS-3).
 */
function StatusSummary({ r }: { r: Found }) {
  const lead = r.kind === "service" ? r.serviceName : r.itemsLabel;
  return (
    <div className="status-summary">
      {lead && <p className="status-summary__lead">{lead}</p>}
      {r.summary && r.summary !== lead && <p>{r.summary}</p>}
    </div>
  );
}

export function StatusLookupForm() {
  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFailure(null);
    const parsed = StatusLookup.safeParse({ reference, email });
    if (!parsed.success) {
      const errs: Partial<Record<Field, string>> = {};
      for (const i of parsed.error.issues) {
        const k = i.path[0] as Field;
        if (!errs[k]) errs[k] = i.message;
      }
      // An empty field gets a plain "enter it" message, not the format hint again (VIS-13).
      if (reference.trim() === "") errs.reference = "Enter your reference number";
      if (email.trim() === "") errs.email = "Enter the email you used";
      setErrors(errs);
      (errs.reference ? refInput : emailInput).current?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    setResult(null);
    const res = await lookupStatus(parsed.data);
    setBusy(false);
    if (res.ok) {
      setResult(res.data);
    } else if (res.status === 404) {
      setResult({ found: false, message: NOT_FOUND });
    } else if (res.status === 429) {
      setFailure("Too many lookups in a short time. Wait a minute, then try again.");
    } else {
      setFailure(
        res.kind === "network"
          ? "We couldn't reach Oasis. Check your connection and try again."
          : "Something went wrong on our side. Please try again.",
      );
    }
    requestAnimationFrame(() => resultRef.current?.focus());
  };

  const field = (name: Field, label: string, input: ReactNode, hint?: string) => (
    <div className="field">
      <label className="field__label" htmlFor={`status-${name}`}>
        {label}
      </label>
      {input}
      {hint && (
        <p className="field__hint" id={`status-${name}-hint`}>
          {hint}
        </p>
      )}
      {errors[name] && (
        <p className="field__error" id={`status-${name}-error`}>
          <IconAlert />
          <span>{errors[name]}</span>
        </p>
      )}
    </div>
  );

  const described = (name: Field, hint?: boolean) =>
    [hint ? `status-${name}-hint` : "", errors[name] ? `status-${name}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <>
      <form className="panel stack" noValidate onSubmit={(e) => void onSubmit(e)}>
        {field(
          "reference",
          "Reference number",
          <input
            ref={refInput}
            id="status-reference"
            className="input input--mono"
            value={reference}
            onChange={(e) => setReference(e.target.value.toUpperCase())}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={13}
            aria-required="true"
            aria-invalid={errors.reference ? true : undefined}
            aria-describedby={described("reference", true)}
          />,
          "Looks like OAS-ABCD-2345. It's in your confirmation email.",
        )}
        {field(
          "email",
          "Email",
          <input
            ref={emailInput}
            id="status-email"
            className="input"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-required="true"
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={described("email")}
          />,
        )}
        <button
          type="submit"
          className="btn btn--block"
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? "Looking up…" : "Look up"}
        </button>
      </form>

      <div ref={resultRef} tabIndex={-1} className="status-result" aria-live="polite">
        {failure && (
          <div className="notice notice--danger" role="alert">
            <IconAlert />
            <span>{failure}</span>
          </div>
        )}
        {result && !result.found && (
          <div className="notice">
            <IconAlert />
            <span>{result.message || NOT_FOUND}</span>
          </div>
        )}
        {result?.found && (
          <section className="panel" aria-labelledby="status-result-title">
            <div className="status-head">
              <div>
                <p className="field__hint">{result.kind === "product" ? "Order" : "Booking"}</p>
                <h2 id="status-result-title" className="status-ref">
                  {result.reference}
                </h2>
              </div>
              <span
                className={`badge ${result.status === "cancelled" ? "badge--attention" : "badge--accent"}`}
              >
                {result.status.charAt(0).toUpperCase() + result.status.slice(1)}
              </span>
            </div>
            <StatusSummary r={result} />
            {result.status === "cancelled" ? (
              <div className="notice notice--warn">
                <IconAlert />
                <span>This {result.kind === "product" ? "order" : "booking"} was cancelled.</span>
              </div>
            ) : (
              <Timeline r={result} />
            )}
            <dl className="kv status-kv">
              {result.appointment && (
                <div className="kv__row">
                  <dt>Appointment</dt>
                  <dd>{result.appointment}</dd>
                </div>
              )}
              <div className="kv__row">
                <dt>Placed</dt>
                <dd>{formatDateTimeZoned(result.createdAt)}</dd>
              </div>
              <div className="kv__row">
                <dt>Total</dt>
                <dd>{formatCents(result.totalCents)}</dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </>
  );
}
