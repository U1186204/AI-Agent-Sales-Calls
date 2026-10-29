"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  Email,
  type CardAction,
  type ChatErrorCode,
  type ChatEvent,
  type ChatRequest,
  UiBlock,
} from "@/contracts";
import { sendChat } from "@/ui-lib/api";
import { countLookups, traceLinkLabel } from "@/ui-lib/format";
import { isCoarsePointer, scrollBehavior } from "@/ui-lib/motion";
import {
  CHECKOUT_KEY_PREFIX,
  sessionGet,
  sessionRemove,
  sessionRemovePrefix,
  sessionSet,
} from "@/ui-lib/storage";
import { CheckoutForm } from "../checkout/CheckoutForm";
import { cardFlow, ChatCard, isCardBlock } from "./cards";
import {
  BusinessIcon,
  IconAlert,
  IconArrowUp,
  IconChevronLeft,
  IconClose,
  IconLayers,
  IconPerson,
} from "../icons";
import { MessageText } from "./MessageText";
import { TracePanel, type TraceTurn } from "./TracePanel";

export interface ChatBusiness {
  id: string;
  name: string;
  shortName: string;
  kind: "product" | "service";
  tagline: string;
  supportEmail: string;
}

type ErrorCode = ChatErrorCode | "network";

/** What to send again on "Try again" (never re-adds the customer's bubble). */
interface RetryPayload {
  message?: string;
  event?: ChatEvent;
  label?: string;
}

type ChatItem =
  | { id: string; role: "user"; text: string }
  | {
      id: string;
      role: "assistant";
      blocks: UiBlock[];
      offerEscalation?: boolean;
      /** Trace steps of this reply (the link shows when > 0). */
      traceCount: number;
      /** Tool calls among them, for the "N lookups" label (R2-9; absent in older sessions). */
      lookupCount?: number;
      /** Canned reply because the model failed: shown in the error treatment. */
      fallback?: boolean;
      retry?: RetryPayload;
    }
  | {
      id: string;
      role: "error";
      code: ErrorCode;
      retry?: RetryPayload;
      /** Epoch ms before which "Try again" stays disabled (rate limits). */
      retryAt?: number;
    }
  | { id: string; role: "event"; text: string };

interface Stored {
  v: 1;
  conversationId?: string;
  items: ChatItem[];
  turns: TraceTurn[];
}

const storageKey = (businessId: string) => `oasis:chat:${businessId}`;
const COUNTER_FROM = 0.8; // show the character counter past 80% of the limit
const DEFAULT_RATE_LIMIT_WAIT_S = 30;

let idCounter = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

function errorCopy(
  code: ErrorCode,
  maxChars: number,
): { title: string; body: string; retry: boolean } {
  switch (code) {
    case "rate_limited":
      return {
        title: "You're sending messages quickly",
        body: "Give it a moment. Try again unlocks when the wait is over.",
        retry: true,
      };
    case "session_limit":
      return {
        title: "This conversation is at its limit",
        body: "Start over to keep chatting, or talk to a person and the team will follow up.",
        retry: false,
      };
    case "escalation_limited":
      return {
        title: "We've already received your requests",
        body: "Several requests to talk to a person came from here recently, so this one wasn't sent. Please email the team directly.",
        retry: false,
      };
    case "budget_exceeded":
      return {
        title: "The demo has reached its usage budget",
        body: "The assistant is paused for now. Talk to a person and the team will follow up.",
        retry: false,
      };
    case "llm_unavailable":
    case "llm_unconfigured":
      return {
        title: "The assistant is unavailable right now",
        body: "Try again in a moment, or talk to a person and the team will follow up.",
        retry: code === "llm_unavailable",
      };
    case "input_too_long":
      return {
        title: "That message is too long",
        body: `Please keep messages under ${maxChars.toLocaleString("en-US")} characters.`,
        retry: false,
      };
    case "not_found":
      return {
        title: "This conversation expired",
        body: "Your next message starts a new conversation.",
        retry: true,
      };
    case "network":
      return {
        title: "We couldn't reach Oasis",
        body: "Check your connection and try again.",
        retry: true,
      };
    default:
      return {
        title: "Something went wrong",
        body: "Try again, or talk to a person and the team will follow up.",
        retry: true,
      };
  }
}

function welcomeText(b: ChatBusiness): string {
  const can =
    b.kind === "product"
      ? "check live stock and prices, quote shipping to any US ZIP code, and place your order"
      : "price your job, find an open appointment, and book it";
  return `Hi! I'm the ${b.shortName} assistant. I can ${can}. Ask me anything about ${b.shortName} — what can I help you with?`;
}

/** "Try again" that stays disabled (with a visible countdown) until `retryAt`. */
function RetryButton({
  retryAt,
  disabled,
  onClick,
}: {
  retryAt?: number;
  disabled: boolean;
  onClick: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const left = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  useEffect(() => {
    if (!left) return;
    const t = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(t);
  }, [left, now]);
  return (
    <button
      type="button"
      className="btn btn--secondary btn--small"
      disabled={disabled || left > 0}
      onClick={onClick}
    >
      {left > 0 ? (
        <>
          <span className="tabular">{`Try again in ${left}s`}</span>
        </>
      ) : (
        "Try again"
      )}
    </button>
  );
}

export function ChatApp({
  business,
  starters,
  maxChars,
}: {
  business: ChatBusiness;
  starters: readonly string[];
  maxChars: number;
}) {
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [turns, setTurns] = useState<TraceTurn[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [restored, setRestored] = useState(false);
  const [highlight, setHighlight] = useState<string | undefined>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  /** Draft id of a form that just arrived: it takes focus (its heading) on mount. */
  const [focusDraft, setFocusDraft] = useState<string | undefined>();
  /** The card to focus: the answer to a click in the previous card (keeps keyboard flow). */
  const [focusCard, setFocusCard] = useState<string | undefined>();

  // "Talk to a person" inline prompt
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffEmail, setHandoffEmail] = useState("");
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDialogElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const handoffTriggerRef = useRef<HTMLButtonElement>(null);
  const handoffEmailRef = useRef<HTMLInputElement>(null);
  const handoffReturnRef = useRef<HTMLElement | null>(null);
  const sendingRef = useRef(false);
  const convRef = useRef<string | undefined>(undefined);

  // ---- Restore the session (per business) ---------------------------------
  useEffect(() => {
    const saved = sessionGet<Stored>(storageKey(business.id));
    if (saved?.v === 1) {
      convRef.current = saved.conversationId;
      /* eslint-disable react-hooks/set-state-in-effect -- one-time restore from sessionStorage */
      setConversationId(saved.conversationId);
      // Stored blocks are re-validated: a card saved by an older build (or edited by hand)
      // is dropped instead of breaking the whole conversation.
      setItems(
        (saved.items ?? []).map((i) =>
          i.role === "assistant"
            ? { ...i, blocks: i.blocks.filter((b) => UiBlock.safeParse(b).success) }
            : i,
        ),
      );
      setTurns(saved.turns ?? []);
    }
    setRestored(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [business.id]);

  useEffect(() => {
    if (!restored) return;
    sessionSet(storageKey(business.id), { v: 1, conversationId, items, turns } satisfies Stored);
  }, [restored, business.id, conversationId, items, turns]);

  // ---- Keep the newest message in view -------------------------------------
  const lastItemId = items[items.length - 1]?.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !lastItemId) return;
    const last = el.querySelector<HTMLElement>(`[data-item="${lastItemId}"]`);
    const behavior = scrollBehavior();
    // Forms are tall: show their top. Everything else: scroll to the bottom.
    if (last?.dataset.wide === "true") last.scrollIntoView({ block: "start", behavior });
    else el.scrollTo({ top: el.scrollHeight, behavior });
  }, [lastItemId, sending]);

  // ---- Composer autosize ---------------------------------------------------
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // ---- Sending -------------------------------------------------------------
  const send = useCallback(
    async (opts: RetryPayload & { retryOf?: string; userText?: string }) => {
      if (sendingRef.current) return false;
      const message = opts.message?.trim();
      if (!message && !opts.event) return false;
      sendingRef.current = true;
      setSending(true);

      setItems((prev) => {
        // "Try again" replaces the failed card and never re-adds the customer's bubble (WF-6).
        const base = opts.retryOf ? prev.filter((i) => i.id !== opts.retryOf) : prev;
        if (opts.retryOf) return base;
        if (message) return [...base, { id: newId("u"), role: "user", text: message }];
        if (opts.userText)
          return [...base, { id: newId("ev"), role: "event", text: opts.userText }];
        return base;
      });

      const req: ChatRequest = {
        businessId: business.id as ChatRequest["businessId"],
        ...(convRef.current ? { conversationId: convRef.current } : {}),
        ...(message ? { message } : {}),
        ...(opts.event ? { event: opts.event } : {}),
      };
      const retry: RetryPayload = { message, event: opts.event, label: opts.label };
      const res = await sendChat(req);
      sendingRef.current = false;
      setSending(false);

      if (res.ok) {
        const data = res.data;
        convRef.current = data.conversationId;
        setConversationId(data.conversationId);
        const id = newId("a");
        const additions: ChatItem[] = [];
        const isFallback = data.fallback || Boolean(data.error);
        if (data.blocks.length > 0) {
          additions.push({
            id,
            role: "assistant",
            blocks: data.blocks,
            offerEscalation: data.offerEscalation,
            traceCount: data.trace.length,
            lookupCount: countLookups(data.trace),
            ...(isFallback ? { fallback: true, retry } : {}),
          });
        } else if (data.error) {
          additions.push({ id: newId("e"), role: "error", code: data.error.code, retry });
        }
        setItems((prev) => [...prev, ...additions]);
        setTurns((prev) => [
          ...prev,
          {
            id,
            index: prev.length + 1,
            prompt: opts.label ?? message ?? "",
            steps: data.trace,
            usage: data.usage,
          },
        ]);
        const firstText = data.blocks.find((b) => b.type === "text");
        const form = data.blocks.find((b) => b.type === "form");
        const firstCard = data.blocks.find(isCardBlock);
        if (form && form.type === "form") setFocusDraft(form.draftId);
        else if (firstCard && opts.event?.type === "card_action") setFocusCard(firstCard.cardId);
        if (data.blocks.length === 0 && data.error) {
          const copy = errorCopy(data.error.code, maxChars);
          setAnnounce(`${copy.title}. ${copy.body}`);
        } else {
          setAnnounce(
            `${business.shortName} assistant: ${firstText && firstText.type === "text" ? firstText.text.replace(/\*\*/g, "") : ""}${
              form ? " A secure form is ready below." : firstCard ? " Options are shown below." : ""
            }`,
          );
        }
        return true;
      }
      if (res.code === "not_found") {
        convRef.current = undefined;
        setConversationId(undefined);
      }
      const wait =
        res.code === "rate_limited" ? (res.retryAfterSec ?? DEFAULT_RATE_LIMIT_WAIT_S) : 0;
      setItems((prev) => [
        ...prev,
        {
          id: newId("e"),
          role: "error",
          code: res.code,
          retry,
          ...(wait ? { retryAt: Date.now() + wait * 1000 } : {}),
        },
      ]);
      // One announcement (the card itself is not a live region; A11Y-7).
      const copy = errorCopy(res.code, maxChars);
      setAnnounce(`${copy.title}. ${copy.body}`);
      return false;
    },
    [business.id, business.shortName, maxChars],
  );

  const submitComposer = () => {
    const value = text.trim();
    if (!value || value.length > maxChars || sendingRef.current) return;
    setText("");
    void send({ message: value });
    // On touch devices keep the soft keyboard closed so the reply (or a form) is readable.
    if (isCoarsePointer()) inputRef.current?.blur();
    else inputRef.current?.focus();
  };

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitComposer();
    }
  };

  // ---- Talk to a person (deterministic hand-off, no model involved) --------
  const openHandoff = (from?: HTMLElement | null) => {
    handoffReturnRef.current = from ?? handoffTriggerRef.current;
    setHandoffError(null);
    setHandoffOpen(true);
    requestAnimationFrame(() => handoffEmailRef.current?.focus());
  };
  const closeHandoff = (restoreFocus = true) => {
    setHandoffOpen(false);
    setHandoffError(null);
    if (restoreFocus) {
      const back = handoffReturnRef.current;
      requestAnimationFrame(() =>
        (back && back.isConnected ? back : handoffTriggerRef.current)?.focus(),
      );
    }
  };
  const submitHandoff = async (e: FormEvent) => {
    e.preventDefault();
    const raw = handoffEmail.trim();
    let contactEmail: string | undefined;
    if (raw) {
      const parsed = Email.safeParse(raw);
      if (!parsed.success) {
        setHandoffError("Enter a valid email address, or leave it blank.");
        handoffEmailRef.current?.focus();
        return;
      }
      contactEmail = parsed.data;
    }
    closeHandoff(false);
    setHandoffEmail("");
    await send({
      event: { type: "request_human", ...(contactEmail ? { contactEmail } : {}) },
      label: "Asked to talk to a person",
      userText: "You asked to talk to a person",
    });
    if (!isCoarsePointer()) inputRef.current?.focus();
  };

  const startOver = () => {
    sessionRemove(storageKey(business.id));
    sessionRemovePrefix(CHECKOUT_KEY_PREFIX);
    convRef.current = undefined;
    setConversationId(undefined);
    setItems([]);
    setTurns([]);
    setHighlight(undefined);
    setText("");
    setFocusDraft(undefined);
    setFocusCard(undefined);
    setAnnounce("Started a new conversation.");
    inputRef.current?.focus();
  };

  const onCheckoutCompleted = useCallback(
    (reference: string, draftId: string) => {
      setItems((prev) => [
        ...prev,
        {
          id: newId("ev"),
          role: "event",
          text: `${business.kind === "service" ? "Booking" : "Order"} ${reference} confirmed`,
        },
      ]);
      void send({
        event: { type: "checkout_completed", draftId, reference },
        label: `Checkout completed (${reference})`,
      });
    },
    [business.kind, send],
  );

  /** A click in a card: shown as an event pill, handled by the server without the model. */
  const sendCardAction = useCallback(
    (action: CardAction, label: string) => {
      void send({ event: { type: "card_action", action }, userText: label, label });
    },
    [send],
  );

  // Each flow (service: picker → price → times; product: products → cart) moves forward one
  // reply at a time: only the cards of its newest reply take clicks, older ones stay as a
  // read-only record so a stale click can't fork the flow.
  const latestCardItem = new Map<string, string>();
  for (const item of items) {
    if (item.role !== "assistant") continue;
    for (const b of item.blocks) if (isCardBlock(b)) latestCardItem.set(cardFlow(b), item.id);
  }

  // ---- Trace panel / sheet -------------------------------------------------
  const openSheet = () => {
    setSheetOpen(true);
    const d = sheetRef.current;
    if (d && !d.open) d.showModal();
  };
  const closeSheet = () => {
    sheetRef.current?.close();
  };

  const highlightTimer = useRef<number | undefined>(undefined);
  const showTrace = (id: string) => {
    setHighlight(id);
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(undefined), 1800);
    const isWide = window.matchMedia("(min-width: 1024px)").matches;
    if (!isWide) openSheet();
    requestAnimationFrame(() => {
      const root = isWide ? asideRef.current : sheetRef.current;
      const target = root?.querySelector<HTMLElement>(`#trace-${CSS.escape(id)}`);
      target?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      target?.focus({ preventScroll: true });
    });
  };

  const stepCount = turns.reduce((n, t) => n + countLookups(t.steps), 0);
  const userCount = items.filter((i) => i.role === "user").length;
  const over = text.length > maxChars;
  const showCounter = text.length >= maxChars * COUNTER_FROM;

  const talkButton = (key: string, className = "btn btn--secondary btn--small") => (
    <button
      key={key}
      type="button"
      className={className}
      disabled={sending}
      onClick={(e) => openHandoff(e.currentTarget)}
    >
      <IconPerson className="btn__icon" />
      Talk to a person
    </button>
  );

  return (
    <div className="chat-page">
      <header className="chat-header">
        <Link href="/" className="chat-header__back" aria-label="All businesses (oasis home)">
          <IconChevronLeft className="chev" />
          <span className="chat-header__home hide-sm" aria-hidden="true">
            oasis
          </span>
        </Link>
        <span className="chat-header__divider" aria-hidden="true" />
        <div className="chat-header__title">
          <span className="chat-header__name">
            <span className="hide-sm">{business.name}</span>
            <span className="show-sm-only">{business.shortName}</span>
          </span>
        </div>
        <div className="chat-header__actions">
          <button
            type="button"
            className="btn btn--ghost btn--small trace-toggle"
            onClick={openSheet}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
          >
            <IconLayers className="btn__icon hide-sm" />
            <span>
              <span className="hide-sm">How it answered</span>
              <span className="show-sm-only">Trace</span>
            </span>
            {stepCount > 0 && (
              <span className="count-pill">
                {stepCount}
                <span className="visually-hidden"> lookups</span>
              </span>
            )}
          </button>
          {items.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={startOver}
              disabled={sending}
            >
              Start over
            </button>
          )}
        </div>
      </header>

      <div className="chat-body">
        <main id="main" tabIndex={-1} className="chat-main">
          <div className="chat-scroll" ref={scrollRef}>
            <div className="chat-column">
              <div className="chat-intro">
                <span className="chat-intro__mark">
                  <BusinessIcon id={business.id} />
                </span>
                <h1 className="chat-intro__title">{business.name}</h1>
                <p className="chat-intro__sub">{business.tagline}</p>
              </div>

              <ol className="messages" aria-label="Conversation" role="list">
                <li className="msg msg--assistant">
                  <div className="bubble">
                    <MessageText text={welcomeText(business)} />
                  </div>
                  {userCount === 0 && !sending && (
                    <div className="starters" role="group" aria-label="Suggested questions">
                      {starters.map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="starter"
                          onClick={() => void send({ message: s })}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </li>

                {items.map((item) => {
                  if (item.role === "user") {
                    return (
                      <li key={item.id} data-item={item.id} className="msg msg--user">
                        <span className="visually-hidden">You said:</span>
                        <div className="bubble">{item.text}</div>
                      </li>
                    );
                  }
                  if (item.role === "event") {
                    return (
                      <li key={item.id} data-item={item.id} className="msg msg--event">
                        <span className="event-pill">{item.text}</span>
                      </li>
                    );
                  }
                  if (item.role === "error") {
                    const copy = errorCopy(item.code, maxChars);
                    return (
                      <li key={item.id} data-item={item.id} className="msg msg--assistant">
                        <div className="msg-error">
                          <IconAlert />
                          <div className="msg-error__body">
                            <strong className="msg-error__title">{copy.title}</strong>
                            <span>{copy.body}</span>
                            <div className="msg-actions">
                              {copy.retry && item.retry && (
                                <RetryButton
                                  retryAt={item.retryAt}
                                  disabled={sending}
                                  onClick={() => void send({ ...item.retry, retryOf: item.id })}
                                />
                              )}
                              {item.id === lastItemId &&
                                item.code !== "escalation_limited" &&
                                talkButton("talk")}
                            </div>
                            <span className="msg-error__mail">
                              Or write to{" "}
                              <a className="email" href={`mailto:${business.supportEmail}`}>
                                {business.supportEmail}
                              </a>
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  }
                  if (item.fallback) {
                    return (
                      <li key={item.id} data-item={item.id} className="msg msg--assistant">
                        <span className="visually-hidden">
                          {business.shortName} assistant said:
                        </span>
                        <div className="msg-error">
                          <IconAlert />
                          <div className="msg-error__body">
                            {item.blocks.map((block, i) =>
                              block.type === "text" ? (
                                <div key={i} className="msg-error__text">
                                  <MessageText text={block.text} />
                                </div>
                              ) : null,
                            )}
                            <div className="msg-actions">
                              {item.retry && (
                                <RetryButton
                                  disabled={sending}
                                  onClick={() => void send({ ...item.retry, retryOf: item.id })}
                                />
                              )}
                              {item.id === lastItemId && talkButton("talk")}
                            </div>
                          </div>
                        </div>
                        {item.traceCount > 0 && (
                          <div className="msg__footer">
                            <button
                              type="button"
                              className="msg__trace-link"
                              onClick={() => showTrace(item.id)}
                            >
                              <IconLayers />
                              {traceLinkLabel(item.lookupCount ?? item.traceCount)}
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  }
                  const hasForm = item.blocks.some((b) => b.type !== "text");
                  return (
                    <li
                      key={item.id}
                      data-item={item.id}
                      data-wide={hasForm}
                      className={`msg msg--assistant ${hasForm ? "msg--wide" : ""}`}
                    >
                      <span className="visually-hidden">{business.shortName} assistant said:</span>
                      {item.blocks.map((block, i) =>
                        block.type === "text" ? (
                          <div className="bubble" key={i}>
                            <MessageText text={block.text} />
                          </div>
                        ) : isCardBlock(block) ? (
                          <ChatCard
                            key={block.cardId}
                            block={block}
                            active={latestCardItem.get(cardFlow(block)) === item.id}
                            autoFocus={focusCard === block.cardId}
                            onAction={sendCardAction}
                            onTalk={openHandoff}
                          />
                        ) : (
                          <CheckoutForm
                            key={`${block.draftId}-${i}`}
                            draftId={block.draftId}
                            kind={block.kind}
                            summary={block.summary}
                            conversationId={conversationId ?? ""}
                            autoFocus={focusDraft === block.draftId}
                            onCompleted={onCheckoutCompleted}
                          />
                        ),
                      )}
                      <div className="msg__footer">
                        {item.traceCount > 0 && (
                          <button
                            type="button"
                            className="msg__trace-link"
                            onClick={() => showTrace(item.id)}
                          >
                            <IconLayers />
                            {traceLinkLabel(item.lookupCount ?? item.traceCount)}
                          </button>
                        )}
                        {item.offerEscalation && talkButton("talk", "msg__trace-link")}
                      </div>
                    </li>
                  );
                })}

                {sending && (
                  <li className="msg msg--assistant" aria-hidden="true">
                    <div className="typing">
                      <span />
                      <span />
                      <span />
                    </div>
                  </li>
                )}
              </ol>
              <p className="visually-hidden" role="status" aria-live="polite">
                {sending ? `${business.shortName} assistant is typing…` : ""}
              </p>
              <div className="visually-hidden" aria-live="polite" aria-atomic="true">
                {announce}
              </div>
            </div>
          </div>

          <div className="composer-wrap">
            {handoffOpen && (
              <form
                id="handoff"
                className="handoff"
                aria-labelledby="handoff-title"
                noValidate
                onSubmit={(e) => void submitHandoff(e)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeHandoff();
                  }
                }}
              >
                <div className="handoff__head">
                  <h2 id="handoff-title" className="handoff__title">
                    Talk to a person
                  </h2>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Cancel"
                    onClick={() => closeHandoff()}
                  >
                    <IconClose />
                  </button>
                </div>
                <p className="handoff__text">
                  We&rsquo;ll pass this conversation to the {business.shortName} team. Add your
                  email so they can reply to you.
                </p>
                <div className="handoff__row">
                  <div className="field handoff__field">
                    <label className="field__label" htmlFor="handoff-email">
                      Your email <span className="field__optional">(optional)</span>
                    </label>
                    <input
                      ref={handoffEmailRef}
                      id="handoff-email"
                      className="input"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      maxLength={254}
                      value={handoffEmail}
                      onChange={(e) => {
                        setHandoffEmail(e.target.value);
                        if (handoffError) setHandoffError(null);
                      }}
                      aria-invalid={handoffError ? true : undefined}
                      aria-describedby={handoffError ? "handoff-error" : undefined}
                    />
                  </div>
                  <button type="submit" className="btn" disabled={sending}>
                    Send to the team
                  </button>
                </div>
                {handoffError && (
                  <p className="field__error" id="handoff-error">
                    <IconAlert />
                    <span>{handoffError}</span>
                  </p>
                )}
              </form>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                submitComposer();
              }}
            >
              <label htmlFor="chat-input" className="visually-hidden">
                Message {business.shortName}
              </label>
              <div className="composer__box" data-invalid={over}>
                <textarea
                  id="chat-input"
                  ref={inputRef}
                  className="composer__input"
                  rows={1}
                  value={text}
                  placeholder={`Message ${business.shortName}`}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onComposerKey}
                  aria-invalid={over || undefined}
                  aria-describedby={showCounter ? "chat-count chat-hint" : "chat-hint"}
                  enterKeyHint="send"
                  autoComplete="off"
                />
                <button
                  type="submit"
                  className="composer__send"
                  disabled={sending || text.trim() === "" || over}
                  aria-label={sending ? "Sending…" : "Send message"}
                >
                  {sending ? <span className="spinner" aria-hidden="true" /> : <IconArrowUp />}
                </button>
              </div>
              <div className="composer__meta">
                <button
                  ref={handoffTriggerRef}
                  type="button"
                  className="composer__talk"
                  aria-expanded={handoffOpen}
                  aria-controls={handoffOpen ? "handoff" : undefined}
                  onClick={(e) => (handoffOpen ? closeHandoff() : openHandoff(e.currentTarget))}
                >
                  <IconPerson />
                  Talk to a person
                </button>
                <span id="chat-hint" className="composer__hint">
                  Enter to send, Shift + Enter for a new line. Never type card numbers here.
                </span>
                {showCounter && (
                  <span id="chat-count" className={`counter ${over ? "counter--over" : ""}`}>
                    {text.length.toLocaleString("en-US")} / {maxChars.toLocaleString("en-US")}
                    <span className="visually-hidden"> characters{over ? ", too long" : ""}</span>
                  </span>
                )}
              </div>
            </form>
          </div>
        </main>

        <aside className="trace-aside" ref={asideRef} aria-labelledby="trace-title-aside">
          <TracePanel turns={turns} highlightId={highlight} headingId="trace-title-aside" />
        </aside>
      </div>

      <dialog
        ref={sheetRef}
        className="sheet"
        aria-labelledby="trace-title-sheet"
        onClose={() => setSheetOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeSheet();
        }}
      >
        <div className="sheet__grip" aria-hidden="true" />
        <div className="sheet__bar">
          <span />
          <button type="button" className="icon-btn" onClick={closeSheet} aria-label="Close panel">
            <IconClose />
          </button>
        </div>
        <div className="sheet__content">
          {sheetOpen && (
            <TracePanel turns={turns} highlightId={highlight} headingId="trace-title-sheet" />
          )}
        </div>
      </dialog>
    </div>
  );
}
