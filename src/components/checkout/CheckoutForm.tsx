"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  CustomerForm,
  US_STATE_CODES,
  US_STATE_NAMES,
  type CheckoutDraftView,
  type CheckoutInput,
  type CheckoutKind,
  type CheckoutReview,
  type CheckoutResult,
  type CustomerFormData,
  type ServiceConfig,
  type SlotSummary,
} from "@/contracts";
import {
  getDraft,
  getDraftSlots,
  patchDraftSelection,
  postConfirm,
  postReview,
  type CheckoutFailure,
} from "@/ui-lib/api";
import {
  formatCents,
  formatDuration,
  formatIsoDateLong,
  isoDateInTz,
  timezoneName,
} from "@/ui-lib/format";
import { maskPhone, maskZip } from "@/ui-lib/masks";
import { configSummary, sameConfig } from "@/ui-lib/service-config";
import { scrollBehavior } from "@/ui-lib/motion";
import { checkoutKey, sessionGet, sessionRemove, sessionSet } from "@/ui-lib/storage";
import { IconAlert, IconCheck, IconInfo, IconLock } from "../icons";
import { DatePicker } from "./DatePicker";
import { QuoteSummary } from "./QuoteSummary";
import { ServiceSpecFields } from "./ServiceSpecFields";

/** Wait this long after the last change before re-pricing (one request per burst of clicks). */
const SPEC_DEBOUNCE_MS = 350;

// ---------------------------------------------------------------------------

type FieldName =
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "address1"
  | "address2"
  | "city"
  | "state"
  | "zip"
  | "instructions";
type ErrorKey = FieldName | "slot";
type Values = Record<FieldName, string>;
type Errors = Partial<Record<ErrorKey, string>>;

const FIELD_ORDER: FieldName[] = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "address1",
  "address2",
  "city",
  "state",
  "zip",
  "instructions",
];
const EMPTY: Values = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
  instructions: "",
};
const INSTRUCTIONS_MAX = 500;

const STATE_NAMES = US_STATE_NAMES;
const TERRITORIES = new Set(["PR", "GU", "VI", "AS", "MP"]);
const byName = (a: string, b: string) => (STATE_NAMES[a] ?? a).localeCompare(STATE_NAMES[b] ?? b);
const STATE_CODES: readonly string[] = US_STATE_CODES;
const SORTED_STATES = STATE_CODES.filter((s) => !TERRITORIES.has(s)).sort(byName);
const SORTED_TERRITORIES = STATE_CODES.filter((s) => TERRITORIES.has(s)).sort(byName);
/** R2-7: shipping policy excludes military mail; said up front under the street address. */
const MILITARY_HINT = "Military APO/FPO/DPO addresses aren't supported in this demo.";

/** "2 × Name (EL-XYZ); 1 × Other (EL-ABC)" → "2 × Name; 1 × Other" (SKUs live in the trace). */
export function stripSkus(summary: string): string {
  return summary
    .split("; ")
    .map((part) => part.replace(/\s*\([A-Z0-9][A-Z0-9-]*\)\s*$/, ""))
    .join("; ");
}

/** Service subtitle: only what the title doesn't already say, plus the duration. */
function serviceSubtitle(summary: string, name: string, tierName: string, durationMin: number) {
  let rest = summary;
  for (const part of [name, tierName]) if (part) rest = rest.split(part).join("");
  rest = rest
    .replace(/\(?\s*about\s+[\d.]+\s*(hr|hours?|min|minutes?)[^)]*\)?/gi, "")
    .replace(/^[\s—–·,:;()+-]+|[\s—–·,:;()+-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const duration = `About ${formatDuration(durationMin)}`;
  return rest ? `${rest} · ${duration}` : duration;
}

function validate(values: Values): { data?: CustomerFormData; errors: Errors } {
  const res = CustomerForm.safeParse(values);
  if (res.success) return { data: res.data, errors: {} };
  const errors: Errors = {};
  for (const issue of res.error.issues) {
    const key = issue.path[0] as FieldName | undefined;
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return { errors };
}

// ---------------------------------------------------------------------------

function ErrorText({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="field__error">
      <IconAlert />
      <span>{children}</span>
    </p>
  );
}

type Step = "form" | "review" | "done";
type Fatal = { title: string; message: string };
type Done = { reference: string; totalCents: number; replayed: boolean };
type FocusTarget = "title" | "review" | "success";

/** What this tab remembers about one checkout form (sessionStorage, never the server). */
interface Saved {
  v: 1;
  values?: Values;
  date?: string | null;
  slotId?: string | null;
  /** Final confirmed result (shipping-inclusive total), so a reload shows the right total. */
  result?: { reference: string; totalCents: number };
}

/**
 * Shipping-inclusive total of a completed draft (WF-3): the result this tab saved at confirm,
 * else the draft's quote, which the server replaces with the final (confirmed) quote.
 */
function finalTotal(d: CheckoutDraftView, saved: Saved | undefined): number {
  if (saved?.result && saved.result.reference === d.resultRef) return saved.result.totalCents;
  return d.quote.totalCents;
}

export interface CheckoutFormProps {
  draftId: string;
  kind: CheckoutKind;
  summary: string;
  /** The conversation that created the draft; the server only serves the draft to it. */
  conversationId: string;
  /** Move focus to the form's heading on mount (a form that just arrived in the chat). */
  autoFocus?: boolean;
  /** Called once after a successful confirm (not on reload of a completed draft). */
  onCompleted?: (reference: string, draftId: string) => void;
}

export function CheckoutForm({
  draftId,
  kind,
  summary,
  conversationId,
  autoFocus,
  onCompleted,
}: CheckoutFormProps) {
  const uid = useId().replace(/:/g, "");
  const fid = (name: string) => `${uid}-${name}`;
  const rootRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);
  const busyRef = useRef(false);

  const [draft, setDraft] = useState<CheckoutDraftView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<Fatal | null>(null);
  const [step, setStep] = useState<Step>("form");
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<"review" | "confirm" | null>(null);
  const [review, setReview] = useState<CheckoutReview | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  // Service scheduling
  const [date, setDate] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [slots, setSlots] = useState<Record<string, SlotSummary[]>>({});
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  // Service details (editable configuration, re-priced by the server). Starts as a one-line
  // summary: the specs were usually chosen in chat, and scheduling stays one tab away.
  const [spec, setSpec] = useState<ServiceConfig | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [specPending, setSpecPending] = useState(false);
  const [specError, setSpecError] = useState<string | null>(null);
  const [specNote, setSpecNote] = useState("");
  const specTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const specAbort = useRef<AbortController | null>(null);
  /** The configuration the server last priced (what the shown total belongs to). */
  const specSaved = useRef<ServiceConfig | null>(null);
  /** Latest date/time choice, read after an async re-price (avoids stale closures). */
  const whenRef = useRef<{ date: string | null; slotId: string | null }>({
    date: null,
    slotId: null,
  });

  const isService = kind === "service";

  // ---- Load draft --------------------------------------------------------
  const loadDraft = useCallback(async () => {
    setLoadError(null);
    const stored = sessionGet<Saved>(checkoutKey(draftId));
    const saved = stored?.v === 1 ? stored : undefined;
    const res = await getDraft(draftId, conversationId);
    if (!res.ok) {
      if (res.status === 404) {
        setFatal({
          title: "This checkout is no longer available",
          message: "Ask the assistant to start a new checkout and it will prepare a fresh form.",
        });
      } else {
        setLoadError(
          res.kind === "network"
            ? "We couldn't load the checkout form. Check your connection and try again."
            : "We couldn't load the checkout form. Please try again.",
        );
      }
      return;
    }
    const d = res.data;
    setDraft(d);
    if (d.service) {
      setSpec(d.service.config);
      specSaved.current = d.service.config;
    }
    if (d.status === "completed" && d.resultRef) {
      setDone({ reference: d.resultRef, totalCents: finalTotal(d, saved), replayed: true });
      setStep("done");
    } else if (d.status === "expired" || Date.parse(d.expiresAt) < Date.now()) {
      sessionRemove(checkoutKey(draftId));
      setFatal({
        title: "This checkout expired",
        message:
          "Checkout forms stay open for 30 minutes. Ask the assistant to start again — your selections only take a moment to restore.",
      });
    } else {
      // EDGE-6: restore what this tab typed before a reload (sessionStorage only).
      if (saved?.values) setValues({ ...EMPTY, ...saved.values });
      if (saved?.date && d.availability?.dates.includes(saved.date)) {
        setDate(saved.date);
        setSlotId(saved.slotId ?? null);
      } else if (d.service?.slot) {
        setDate(isoDateInTz(d.service.slot.startsAt, d.service.slot.timezone));
        setSlotId(d.service.slot.slotId);
      } else if (d.availability?.dates[0]) {
        setDate(d.availability.dates[0]);
      }
    }
  }, [draftId, conversationId]);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  // ---- Remember in-progress fields for this tab (EDGE-6) -------------------
  useEffect(() => {
    if (!draft || step === "done" || fatal) return;
    if (!Object.values(values).some((v) => v !== "")) return;
    sessionSet(checkoutKey(draftId), { v: 1, values, date, slotId } satisfies Saved);
  }, [draft, step, fatal, values, date, slotId, draftId]);

  // ---- Focus management (A11Y-1, A11Y-14) ----------------------------------
  const autoFocusOnce = useRef(autoFocus);
  useEffect(() => {
    if (!autoFocusOnce.current) return;
    autoFocusOnce.current = false;
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // After a step change, focus that step's heading (tabIndex=-1) and bring the card into view.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    const el =
      target === "review"
        ? reviewHeadingRef.current
        : target === "success"
          ? successHeadingRef.current
          : titleRef.current;
    if (!el) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
    rootRef.current?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  });

  // ---- Load slots for the chosen date -------------------------------------
  const loadSlots = useCallback(
    async (d: string, force = false) => {
      if (!force && slots[d]) return;
      setSlotsLoading(true);
      setSlotsError(null);
      const res = await getDraftSlots(draftId, d, conversationId);
      setSlotsLoading(false);
      if (!res.ok) {
        setSlotsError("We couldn't load times for this day. Try again or pick another day.");
        return;
      }
      setSlots((prev) => ({ ...prev, [d]: res.data.slots }));
    },
    [draftId, slots, conversationId],
  );

  useEffect(() => {
    if (isService && date && step === "form") void loadSlots(date);
  }, [isService, date, step, loadSlots]);

  // ---- Service details ----------------------------------------------------
  useEffect(() => {
    whenRef.current = { date, slotId };
  }, [date, slotId]);

  useEffect(
    () => () => {
      if (specTimer.current) clearTimeout(specTimer.current);
      specAbort.current?.abort();
    },
    [],
  );

  const saveSpec = async (next: ServiceConfig) => {
    specAbort.current?.abort();
    const ctrl = new AbortController();
    specAbort.current = ctrl;
    let res: Awaited<ReturnType<typeof patchDraftSelection>>;
    try {
      res = await patchDraftSelection(draftId, { conversationId, config: next }, ctrl.signal);
    } catch {
      return; // superseded by a newer change
    }
    if (ctrl.signal.aborted) return;
    setSpecPending(false);
    if (res.ok) {
      const d = res.data.draft;
      setDraft(d);
      specSaved.current = d.service?.config ?? next;
      const price = `Price updated to ${formatCents(d.quote.totalCents)}.`;
      const repick = `${price} Your chosen time doesn't fit the new visit length, so please pick a new time.`;
      // The job length may have changed: re-check the chosen day and time against it.
      const { date: day, slotId: chosen } = whenRef.current;
      const dates = d.availability?.dates ?? [];
      if (!day || !dates.includes(day)) {
        setSlots({});
        setDate(dates[0] ?? null);
        setSlotId(null);
        setSpecNote(chosen ? repick : price);
        return;
      }
      const fresh = await getDraftSlots(draftId, day, conversationId);
      if (ctrl.signal.aborted) return;
      setSlots(fresh.ok ? { [day]: fresh.data.slots } : {});
      const still = fresh.ok && fresh.data.slots.some((x) => x.slotId === whenRef.current.slotId);
      if (whenRef.current.slotId && !still) {
        setSlotId(null);
        setSpecNote(repick);
      } else {
        setSpecNote(price);
      }
      return;
    }
    if (res.code === "validation") {
      const first = Object.values(res.fieldErrors ?? {})[0]?.[0];
      setSpecError(first ?? res.message);
      // Show the configuration the displayed price belongs to.
      if (specSaved.current) setSpec(specSaved.current);
      return;
    }
    applyFailure(res);
  };

  const onSpecChange = (next: ServiceConfig) => {
    setSpec(next);
    setSpecError(null);
    if (specTimer.current) clearTimeout(specTimer.current);
    if (specSaved.current && sameConfig(next, specSaved.current)) {
      specAbort.current?.abort();
      setSpecPending(false);
      return;
    }
    setSpecPending(true);
    specTimer.current = setTimeout(() => void saveSpec(next), SPEC_DEBOUNCE_MS);
  };

  // ---- Field handling -----------------------------------------------------
  const setField = (name: FieldName, value: string) => {
    const next = { ...values, [name]: value };
    setValues(next);
    // Live re-validation only clears/updates an error already shown; it never nags mid-typing.
    if (errors[name]) setErrors((e) => ({ ...e, [name]: validate(next).errors[name] }));
  };

  const onBlur = (name: FieldName) => {
    // Don't nag about empty required fields the customer just tabbed past.
    if (values[name].trim() === "" && !errors[name]) return;
    setErrors((e) => ({ ...e, [name]: validate(values).errors[name] }));
  };

  const onMasked = (name: "phone" | "zip") => (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const caret = el.selectionStart ?? el.value.length;
    const r =
      name === "phone" ? maskPhone(el.value, caret, values.phone) : maskZip(el.value, caret);
    setField(name, r.value);
    requestAnimationFrame(() => {
      if (document.activeElement === el) el.setSelectionRange(r.caret, r.caret);
    });
  };

  const focusFirstError = (errs: Errors) => {
    const order: ErrorKey[] = isService ? ["slot", ...FIELD_ORDER] : FIELD_ORDER;
    const first = order.find((k) => errs[k]);
    if (!first) return;
    requestAnimationFrame(() => {
      if (first === "slot") {
        const target =
          formRef.current?.querySelector<HTMLElement>(`input[name="${fid("time")}"]`) ??
          formRef.current?.querySelector<HTMLElement>(".cal__day[tabindex='0']");
        target?.focus();
      } else {
        document.getElementById(fid(first))?.focus();
      }
    });
  };

  const body = (data: CustomerFormData): CheckoutInput =>
    isService
      ? { kind: "service", draftId, conversationId, customer: data, slotId: slotId ?? undefined }
      : { kind: "product", draftId, conversationId, customer: data };

  /** Change step and move focus to that step's heading once it renders. */
  const goTo = (next: Step, focus: FocusTarget) => {
    pendingFocus.current = focus;
    setStep(next);
  };

  /** Apply a structured server error. Returns to the form when the customer can fix it. */
  const applyFailure = (f: CheckoutFailure) => {
    switch (f.code) {
      case "validation": {
        const errs: Errors = {};
        for (const [k, msgs] of Object.entries(f.fieldErrors ?? {})) {
          // Canonical server keys: bare CustomerForm field names, plus `slotId` for the time.
          const key = (k === "slotId" ? "slot" : k) as ErrorKey;
          if (msgs[0]) errs[key] = msgs[0];
        }
        setErrors(errs);
        setBanner(Object.keys(errs).length ? null : f.message);
        setStep("form");
        focusFirstError(errs);
        return;
      }
      case "outside_service_area": {
        const errs = { zip: f.message };
        setErrors(errs);
        setStep("form");
        focusFirstError(errs);
        return;
      }
      case "slot_unavailable": {
        const errs = {
          slot: "That time was just booked by someone else. Please pick another time.",
        };
        setErrors(errs);
        setSlotId(null);
        setStep("form");
        if (date) void loadSlots(date, true);
        focusFirstError(errs);
        return;
      }
      case "out_of_stock":
        setFatal({
          title: "Some items just sold out",
          message: `${f.message} Ask the assistant for an alternative or a smaller quantity, and it will prepare a new checkout.`,
        });
        return;
      case "draft_expired":
      case "draft_not_found":
        setFatal({
          title: "This checkout expired",
          message: "Ask the assistant to start again and it will prepare a fresh form.",
        });
        return;
      case "already_completed":
        setBanner(
          "This checkout was already confirmed. Check your email for the reference number.",
        );
        return;
      case "rate_limited":
        setBanner("Too many attempts in a short time. Wait a moment, then try again.");
        return;
      default:
        setBanner(f.message || "Something went wrong on our side. Please try again.");
    }
  };

  // ---- Step 1 → 2 ---------------------------------------------------------
  const onSubmitForm = async (e: FormEvent) => {
    e.preventDefault();
    if (busyRef.current || specPending) return;
    setBanner(null);
    const { data, errors: errs } = validate(values);
    if (isService && !slotId) errs.slot = "Choose an appointment time";
    setErrors(errs);
    if (!data || Object.keys(errs).some((k) => errs[k as ErrorKey])) {
      focusFirstError(errs);
      return;
    }
    busyRef.current = true;
    setBusy("review");
    const res = await postReview(body(data));
    busyRef.current = false;
    setBusy(null);
    if (res.ok) {
      setReview(res.data);
      goTo("review", "review");
    } else {
      applyFailure(res);
    }
  };

  // ---- Step 2 → 3 ---------------------------------------------------------
  const onConfirm = async () => {
    if (busyRef.current) return;
    const { data } = validate(values);
    if (!data) {
      setStep("form");
      return;
    }
    busyRef.current = true;
    setBusy("confirm");
    setBanner(null);
    const res: CheckoutResult = await postConfirm(body(data));
    setBusy(null);
    if (res.ok) {
      // Keep busyRef set: a confirmed checkout can never be submitted again.
      setDone({ reference: res.reference, totalCents: res.totalCents, replayed: res.replayed });
      // Forget the typed details; keep only the final total for a reload (WF-3).
      sessionSet(checkoutKey(draftId), {
        v: 1,
        result: { reference: res.reference, totalCents: res.totalCents },
      } satisfies Saved);
      goTo("done", "success");
      onCompleted?.(res.reference, draftId);
    } else {
      busyRef.current = false;
      applyFailure(res);
    }
  };

  // ---- Render helpers -----------------------------------------------------
  const describedBy = (name: ErrorKey, extra?: string) =>
    [errors[name] ? fid(`${name}-error`) : null, extra].filter(Boolean).join(" ") || undefined;

  const input = (
    name: FieldName,
    label: string,
    opts: {
      type?: string;
      autoComplete?: string;
      inputMode?: "text" | "email" | "tel" | "numeric";
      placeholder?: string;
      optional?: boolean;
      className?: string;
      maxLength?: number;
      hint?: string;
      onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
    } = {},
  ) => (
    <div className={`field ${opts.className ?? ""}`}>
      <label className="field__label" htmlFor={fid(name)}>
        {label}
        {opts.optional && <span className="field__optional"> (optional)</span>}
      </label>
      <input
        id={fid(name)}
        name={name}
        className="input"
        type={opts.type ?? "text"}
        autoComplete={opts.autoComplete}
        inputMode={opts.inputMode}
        placeholder={opts.placeholder}
        maxLength={opts.maxLength}
        value={values[name]}
        onChange={opts.onChange ?? ((e) => setField(name, e.target.value))}
        onBlur={() => onBlur(name)}
        aria-invalid={errors[name] ? true : undefined}
        aria-required={opts.optional ? undefined : true}
        aria-describedby={describedBy(name, opts.hint ? fid(`${name}-hint`) : undefined)}
      />
      {opts.hint && (
        <p className="field__hint" id={fid(`${name}-hint`)}>
          {opts.hint}
        </p>
      )}
      <ErrorText id={fid(`${name}-error`)}>{errors[name]}</ErrorText>
    </div>
  );

  const noun = isService ? "booking" : "order";
  const steps = ["Details", "Review", "Confirmed"];
  const stepIndex = step === "form" ? 0 : step === "review" ? 1 : 2;

  const header = (
    <div className="checkout__head">
      <p className="checkout__eyebrow">
        <IconLock />
        Secure {isService ? "booking" : "checkout"}
      </p>
      <h2 className="checkout__title" ref={titleRef} tabIndex={-1}>
        {draft?.service
          ? `${draft.service.name} · ${draft.service.tierName}`
          : stripSkus(draft?.summary ?? summary)}
      </h2>
      {draft?.service && (
        <p className="checkout__summary">
          {serviceSubtitle(
            draft.summary,
            draft.service.name,
            draft.service.tierName,
            draft.service.durationMin,
          )}
        </p>
      )}
      {!fatal && (
        <ol className="checkout__steps" aria-label="Checkout progress">
          {steps.map((s, i) => (
            <li key={s} aria-current={i === stepIndex ? "step" : undefined}>
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  // ---- States -------------------------------------------------------------
  let content: ReactNode;

  if (fatal) {
    content = (
      <div className="checkout__body">
        <div className="notice notice--warn" role="alert">
          <IconAlert />
          <div className="notice__body">
            <strong>{fatal.title}</strong>
            <span>{fatal.message}</span>
          </div>
        </div>
      </div>
    );
  } else if (!draft) {
    content = loadError ? (
      <div className="checkout__body">
        <div className="notice notice--danger" role="alert">
          <IconAlert />
          <div className="notice__body">
            <span>{loadError}</span>
            <div>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => void loadDraft()}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    ) : (
      <div className="checkout__loading" role="status">
        <span className="spinner" aria-hidden="true" />
        Loading secure form…
      </div>
    );
  } else if (step === "done" && done) {
    content = (
      <div className="success" role="status" aria-live="polite">
        <span className="success__icon">
          <IconCheck />
        </span>
        <h3 className="success__title" ref={successHeadingRef} tabIndex={-1}>
          {isService ? "You're booked" : "Order confirmed"}
        </h3>
        <p>
          Your reference number
          <span className="visually-hidden"> is {done.reference}</span>
        </p>
        <p className="success__ref" aria-hidden="true">
          {done.reference}
        </p>
        <p className="checkout__fine">
          Total {formatCents(done.totalCents)} · pay{" "}
          {isService ? "at your appointment" : "on delivery"}. No payment was collected.
        </p>
        <ul className="success__next">
          <li>A confirmation email with these details is on its way.</li>
          {isService ? (
            <li>
              Your technician arrives within 30 minutes of the start time and texts when on the way.
            </li>
          ) : (
            <li>Orders placed by 2 pm Eastern on a business day ship the same day.</li>
          )}
          <li>
            Check progress any time on the <a href="/status">status page</a> with your reference and
            email.
          </li>
        </ul>
      </div>
    );
  } else if (step === "review" && review) {
    const slot = review.service?.slot;
    content = (
      <div className="checkout__body">
        <h3 className="checkout__step-title" ref={reviewHeadingRef} tabIndex={-1}>
          Review your {noun}
        </h3>
        {banner && (
          <div className="notice notice--danger" role="alert">
            <IconAlert />
            <span>{banner}</span>
          </div>
        )}
        {review.warnings.length > 0 && (
          <div className="notice notice--warn">
            <IconInfo />
            <ul className="notice__body">
              {review.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="review-grid">
          {review.service && slot && (
            <div className="review-block review-block--wide">
              <h4>Appointment</h4>
              <p>
                {formatIsoDateLong(isoDateInTz(slot.startsAt, slot.timezone))}
                <br />
                {slot.localTime} {timezoneName(slot.timezone)}
                <br />
                {review.quote.durationMin !== undefined &&
                  `About ${formatDuration(review.quote.durationMin)} · `}
                with {slot.contractor}
              </p>
            </div>
          )}
          <div className="review-block">
            <h4>Contact</h4>
            <p>
              {review.customer.name}
              <br />
              <span className="email">{review.customer.emailMasked}</span>
              <br />
              {review.customer.phoneMasked}
            </p>
          </div>
          <div className="review-block">
            <h4>{isService ? "Service address" : "Ship to"}</h4>
            <p>{review.customer.addressSummary}</p>
          </div>
        </div>
        <div>
          <h4 className="checkout__section-title">Price</h4>
          <QuoteSummary quote={review.quote} showShipping={!isService} />
        </div>
        <p className="pay-note">
          <IconInfo />
          Pay {isService ? "at your appointment" : "on delivery"} — no payment is collected in this
          demo.
        </p>
        <div className="checkout__actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setBanner(null);
              goTo("form", "title");
            }}
            disabled={busy !== null}
          >
            Edit details
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void onConfirm()}
            disabled={busy !== null}
            aria-busy={busy === "confirm" || undefined}
          >
            {busy === "confirm" && <span className="spinner" aria-hidden="true" />}
            {busy === "confirm" ? "Confirming…" : isService ? "Confirm booking" : "Confirm order"}
          </button>
        </div>
      </div>
    );
  } else {
    const avail = draft.availability;
    const daySlots = date ? slots[date] : undefined;
    const tz = draft.service?.timezone ?? avail?.timezone;
    content = (
      <form
        ref={formRef}
        className="checkout__body"
        noValidate
        onSubmit={(e) => void onSubmitForm(e)}
      >
        {banner && (
          <div className="notice notice--danger" role="alert">
            <IconAlert />
            <span>{banner}</span>
          </div>
        )}

        {isService && draft.service && spec && (
          <details
            className="spec-section"
            open={specOpen}
            onToggle={(e) => setSpecOpen(e.currentTarget.open)}
          >
            <summary className="spec-section__summary">
              <span className="spec-section__text">
                <span className="spec-section__title">Service details</span>
                <span className="spec-section__line">
                  {configSummary(draft.service.options, spec)}
                </span>
              </span>
              <span className="spec-section__edit" aria-hidden="true">
                {specOpen ? "Hide" : "Edit"}
              </span>
            </summary>
            <div className="spec-section__body" aria-busy={specPending || undefined}>
              <ServiceSpecFields
                options={draft.service.options}
                value={spec}
                onChange={onSpecChange}
              />
              {specError && (
                <div className="notice notice--danger" role="alert">
                  <IconAlert />
                  <span>{specError}</span>
                </div>
              )}
              <p className="spec-section__price">
                {specPending ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Updating price…
                  </>
                ) : (
                  <>
                    <strong className="tabular">{formatCents(draft.quote.totalCents)}</strong>
                    {" with estimated tax · about "}
                    {formatDuration(draft.service.durationMin)}
                  </>
                )}
              </p>
            </div>
            <p className="visually-hidden" role="status" aria-live="polite">
              {specNote}
            </p>
          </details>
        )}

        {isService && avail && (
          <fieldset className="fieldset">
            <legend className="fieldset__legend" id={fid("when")}>
              When should we come?
            </legend>
            <div className="when">
              <DatePicker
                id={fid("calendar")}
                labelledBy={fid("when")}
                min={avail.fromDate}
                max={avail.toDate}
                available={avail.dates}
                value={date}
                describedBy={errors.slot ? fid("slot-error") : undefined}
                onChange={(d) => {
                  setDate(d);
                  if (d !== date) setSlotId(null);
                }}
              />
              <div
                role="group"
                aria-labelledby={fid("times-label")}
                aria-describedby={describedBy("slot", fid("tz"))}
              >
                <p className="field__label" id={fid("times-label")}>
                  {date ? `Times on ${formatIsoDateLong(date)}` : "Pick a day to see times"}
                </p>
                {tz && (
                  <p className="field__hint" id={fid("tz")}>
                    {timezoneName(tz)}
                    {draft.service ? ` · about ${formatDuration(draft.service.durationMin)}` : ""}
                  </p>
                )}
                <div
                  className="times-wrap"
                  aria-live="polite"
                  aria-busy={slotsLoading || undefined}
                >
                  {slotsLoading && !daySlots ? (
                    <p className="times-empty" role="status">
                      Loading open times…
                    </p>
                  ) : slotsError ? (
                    <p className="field__error">
                      <IconAlert />
                      <span>{slotsError}</span>
                    </p>
                  ) : daySlots && daySlots.length === 0 ? (
                    <p className="times-empty">
                      That day just filled up. Please choose another day.
                    </p>
                  ) : daySlots ? (
                    <div className="times">
                      {daySlots.map((s) => (
                        <div className="time" key={s.slotId}>
                          <input
                            type="radio"
                            id={fid(`slot-${s.slotId}`)}
                            name={fid("time")}
                            value={s.slotId}
                            checked={slotId === s.slotId}
                            onChange={() => {
                              setSlotId(s.slotId);
                              setErrors((er) => ({ ...er, slot: undefined }));
                            }}
                          />
                          <label htmlFor={fid(`slot-${s.slotId}`)}>{s.localTime}</label>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <ErrorText id={fid("slot-error")}>{errors.slot}</ErrorText>
              </div>
            </div>
          </fieldset>
        )}

        <fieldset className="fieldset">
          <legend className="fieldset__legend">Contact</legend>
          <div className="form-grid">
            {input("firstName", "First name", {
              autoComplete: "given-name",
              className: "span-3",
              maxLength: 50,
            })}
            {input("lastName", "Last name", {
              autoComplete: "family-name",
              className: "span-3",
              maxLength: 50,
            })}
            {input("email", "Email", {
              type: "email",
              autoComplete: "email",
              inputMode: "email",
              className: "span-3",
              maxLength: 254,
            })}
            {input("phone", "Mobile phone", {
              type: "tel",
              autoComplete: "tel-national",
              inputMode: "tel",
              hint: "10-digit US number",
              className: "span-3",
              onChange: onMasked("phone"),
            })}
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="fieldset__legend">
            {isService ? "Service address" : "Shipping address"}
          </legend>
          <div className="form-grid">
            {input("address1", "Street address", {
              autoComplete: "address-line1",
              className: "span-6",
              maxLength: 100,
              hint: isService ? undefined : MILITARY_HINT,
            })}
            {input("address2", "Apartment, suite, unit", {
              autoComplete: "address-line2",
              optional: true,
              className: "span-6",
              maxLength: 100,
            })}
            {input("city", "City", {
              autoComplete: "address-level2",
              className: "span-2",
              maxLength: 60,
            })}
            <div className="field span-2">
              <label className="field__label" htmlFor={fid("state")}>
                State
              </label>
              <select
                id={fid("state")}
                name="state"
                className="select"
                autoComplete="address-level1"
                value={values.state}
                onChange={(e) => setField("state", e.target.value)}
                onBlur={() => onBlur("state")}
                aria-invalid={errors.state ? true : undefined}
                aria-required
                aria-describedby={describedBy("state")}
              >
                <option value="">Select</option>
                {SORTED_STATES.map((s) => (
                  <option key={s} value={s}>
                    {STATE_NAMES[s] ?? s}
                  </option>
                ))}
                {SORTED_TERRITORIES.length > 0 && (
                  <optgroup label="U.S. territories">
                    {SORTED_TERRITORIES.map((s) => (
                      <option key={s} value={s}>
                        {STATE_NAMES[s] ?? s}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <ErrorText id={fid("state-error")}>{errors.state}</ErrorText>
            </div>
            {input("zip", "ZIP code", {
              autoComplete: "postal-code",
              inputMode: "numeric",
              className: "span-2",
              maxLength: 10,
              onChange: onMasked("zip"),
            })}
            <div className="field span-6">
              <label className="field__label" htmlFor={fid("instructions")}>
                {isService ? "Notes for the technician" : "Delivery instructions"}
                <span className="field__optional"> (optional)</span>
              </label>
              <textarea
                id={fid("instructions")}
                name="instructions"
                className="textarea"
                rows={3}
                value={values.instructions}
                onChange={(e) => setField("instructions", e.target.value)}
                onBlur={() => onBlur("instructions")}
                aria-invalid={errors.instructions ? true : undefined}
                aria-describedby={describedBy("instructions", fid("instructions-count"))}
              />
              <div className="field__meta">
                <ErrorText id={fid("instructions-error")}>{errors.instructions}</ErrorText>
                <span
                  id={fid("instructions-count")}
                  className={`counter ${values.instructions.length > INSTRUCTIONS_MAX ? "counter--over" : ""}`}
                >
                  {values.instructions.length} / {INSTRUCTIONS_MAX}
                  <span className="visually-hidden"> characters</span>
                </span>
              </div>
            </div>
          </div>
        </fieldset>

        <details className="details order-peek">
          <summary>
            {isService ? "Price" : "Order summary"} · {formatCents(draft.quote.totalCents)}
            {!isService && " before shipping"}
          </summary>
          <div className="order-peek__body">
            <QuoteSummary
              quote={draft.quote}
              showShipping={!isService}
              shippingPending={!isService}
            />
          </div>
        </details>

        <div className="checkout__actions">
          <p className="checkout__fine checkout__fine--grow">
            Your details go straight to {draft.businessName}, not into the chat.
          </p>
          <button
            type="submit"
            className="btn"
            disabled={busy !== null || specPending}
            aria-busy={busy === "review" || undefined}
          >
            {busy === "review" && <span className="spinner" aria-hidden="true" />}
            {busy === "review" ? "Checking…" : `Review ${noun}`}
          </button>
        </div>
      </form>
    );
  }

  return (
    <section
      ref={rootRef}
      className="checkout"
      aria-label={`Secure ${noun} form`}
      data-step={fatal ? "fatal" : step}
    >
      {header}
      {content}
    </section>
  );
}
