"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { z } from "zod";
import { apiRequest, ownerLogout } from "@/ui-lib/api";
import {
  formatCents,
  formatDateTimeZoned,
  formatDuration,
  formatInt,
  formatIsoDateShort,
  formatUsdAmount,
  humanizeKey,
  splitEmails,
} from "@/ui-lib/format";
import {
  OWNER_ENDPOINTS,
  OWNER_ESCALATIONS_ENDPOINT,
  OwnerTranscript,
  ownerTranscriptPath,
  type OwnerAvailability,
  type OwnerBooking,
  type OwnerConversation,
  type OwnerEscalation,
  type OwnerInventoryItem,
  type OwnerNotification,
  type OwnerOrder,
  type OwnerOverview,
} from "@/contracts";
import { BrandLink } from "../Brand";
import { IconAlert, IconClose, IconSignOut } from "../icons";

/** Every dashboard view: the plain list endpoints plus escalations. */
const ENDPOINTS = { ...OWNER_ENDPOINTS, escalations: OWNER_ESCALATIONS_ENDPOINT } as const;
type TabKey = keyof typeof ENDPOINTS;
type Data = { [K in TabKey]: z.output<(typeof ENDPOINTS)[K]["schema"]> };
type LoadState<T> =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "orders", label: "Orders" },
  { key: "bookings", label: "Bookings" },
  { key: "escalations", label: "Escalations" },
  { key: "conversations", label: "Conversations" },
  { key: "inventory", label: "Inventory" },
  { key: "availability", label: "Availability" },
  { key: "notifications", label: "Notifications" },
];

/** Tabs fit in one row from this width; below it a <select> picks the view (VIS-5). */
const WIDE_TABS_QUERY = "(min-width: 1024px)";

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

interface BizOption {
  id: string;
  name: string;
  kind: "product" | "service";
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

/** Status as text; only problems get the single attention colour (VIS-4). */
function StatusBadge({ status }: { status: string }) {
  const attention = status === "cancelled" || status === "failed" || status === "open";
  return <span className={`badge ${attention ? "badge--attention" : ""}`}>{cap(status)}</span>;
}

// ---------------------------------------------------------------------------
// Table helper: real <table> on wide screens, stacked label/value cards < 768px.
// ---------------------------------------------------------------------------

interface Column<T> {
  key: string;
  label: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

function DataTable<T>({
  caption,
  rows,
  columns,
  rowKey,
  rowAttrs,
  empty,
}: {
  caption: string;
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  rowAttrs?: (r: T) => Record<string, string | undefined>;
  empty: string;
}) {
  if (rows.length === 0) return <p className="table-empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.className}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} {...(rowAttrs?.(r) ?? {})}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={c.className}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="surface-card">
      <div className="surface-card__head">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </section>
  );
}

type OpenTranscript = (conversationId: string, trigger: HTMLElement) => void;

function TranscriptButton({ id, onOpen }: { id: string | null; onOpen: OpenTranscript }) {
  if (!id) return <span className="muted">Not linked</span>;
  return (
    <button
      type="button"
      className="btn btn--secondary btn--small"
      aria-haspopup="dialog"
      onClick={(e) => onOpen(id, e.currentTarget)}
    >
      Transcript
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tab views
// ---------------------------------------------------------------------------

function OverviewView({ data, biz }: { data: OwnerOverview; biz: string }) {
  const rows = data.businesses.filter((b) => biz === "all" || b.businessId === biz);
  const t = data.today;
  const budgetPct = t.dailyBudgetUsd > 0 ? Math.round((t.costUsd / t.dailyBudgetUsd) * 100) : 0;
  const attention = data.totals.openEscalations + data.totals.outOfStock;
  const stats: { label: string; value: string; sub?: string; attention?: boolean }[] = [
    {
      label: "Orders today",
      value: formatInt(t.orders),
      sub: `${formatInt(data.totals.orders)} all time`,
    },
    {
      label: "Bookings today",
      value: formatInt(t.bookings),
      sub: `${formatInt(data.totals.bookings)} all time`,
    },
    {
      label: "Revenue today",
      value: formatCents(t.revenueCents),
      sub: "Orders + bookings, incl. tax",
    },
    {
      label: "AI cost today",
      value: formatUsdAmount(t.costUsd),
      sub: `${budgetPct}% of ${formatUsdAmount(t.dailyBudgetUsd)} daily budget`,
    },
    {
      label: "Conversations today",
      value: formatInt(t.conversations),
      sub: `${formatInt(t.inputTokens + t.outputTokens)} tokens`,
    },
    {
      label: "Needs attention",
      value: formatInt(attention),
      sub: `${data.totals.openEscalations} open escalations · ${data.totals.outOfStock} out of stock`,
      attention: attention > 0,
    },
  ];
  return (
    <>
      <ul className="stats" role="list">
        {stats.map((s) => (
          <li key={s.label} className="stat" data-attention={s.attention || undefined}>
            <p className="stat__label">{s.label}</p>
            <p className="stat__value">{s.value}</p>
            {s.sub && <p className="stat__sub">{s.sub}</p>}
          </li>
        ))}
      </ul>
      <Card
        title="By business"
        sub={`"Today" is ${formatIsoDateShort(t.date)}, UTC. Counts are all time.`}
      >
        <DataTable
          caption="Totals by business"
          rows={rows}
          rowKey={(r) => r.businessId}
          empty="No businesses match this filter."
          columns={[
            { key: "name", label: "Business", cell: (r) => r.businessName },
            {
              key: "kind",
              label: "Type",
              cell: (r) => (r.kind === "product" ? "Products" : "Services"),
            },
            {
              key: "count",
              label: "Orders / bookings",
              className: "num",
              cell: (r) => formatInt(r.kind === "product" ? r.orders : r.bookings),
            },
            {
              key: "conv",
              label: "Conversations",
              className: "num",
              cell: (r) => formatInt(r.conversations),
            },
            {
              key: "rev",
              label: "Revenue",
              className: "num",
              cell: (r) => formatCents(r.revenueCents),
            },
          ]}
        />
      </Card>
    </>
  );
}

function OrdersView({ items }: { items: OwnerOrder[] }) {
  return (
    <Card title="Orders" sub={`${items.length} shown, newest first`}>
      <DataTable
        caption="Orders"
        rows={items}
        rowKey={(r) => r.reference}
        empty="No orders yet. They appear here as soon as a customer confirms checkout."
        columns={[
          { key: "ref", label: "Reference", className: "mono", cell: (r) => r.reference },
          { key: "biz", label: "Business", cell: (r) => r.businessName },
          { key: "cust", label: "Customer", cell: (r) => r.customerName },
          { key: "date", label: "Placed", cell: (r) => formatDateTimeZoned(r.createdAt) },
          { key: "items", label: "Items", className: "num", cell: (r) => formatInt(r.itemCount) },
          {
            key: "zone",
            label: "Shipping zone",
            className: "num",
            cell: (r) => (r.shipZone ? String(r.shipZone) : "—"),
          },
          {
            key: "total",
            label: "Total",
            className: "num",
            cell: (r) => formatCents(r.totalCents),
          },
          { key: "status", label: "Status", cell: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
    </Card>
  );
}

function BookingsView({ items }: { items: OwnerBooking[] }) {
  return (
    <Card
      title="Bookings"
      sub={`${items.length} shown, by appointment time, in each business's zone`}
    >
      <DataTable
        caption="Bookings"
        rows={items}
        rowKey={(r) => r.reference}
        empty="No bookings yet. They appear here as soon as a customer confirms a time."
        columns={[
          { key: "ref", label: "Reference", className: "mono", cell: (r) => r.reference },
          { key: "biz", label: "Business", cell: (r) => r.businessName },
          { key: "svc", label: "Service", cell: (r) => r.serviceName },
          {
            key: "when",
            label: "Appointment",
            cell: (r) => `${r.localStart} · ${formatDuration(r.durationMin)}`,
          },
          { key: "pro", label: "Technician", cell: (r) => r.contractor },
          { key: "cust", label: "Customer", cell: (r) => r.customerName },
          {
            key: "total",
            label: "Total",
            className: "num",
            cell: (r) => formatCents(r.totalCents),
          },
          { key: "status", label: "Status", cell: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
    </Card>
  );
}

function EscalationsView({ items, onOpen }: { items: OwnerEscalation[]; onOpen: OpenTranscript }) {
  const open = items.filter((i) => i.status === "open").length;
  return (
    <Card
      title="Escalations"
      sub={`${open} open · ${items.length} shown, newest first. Contact details are masked.`}
    >
      <DataTable
        caption="Escalations"
        rows={items}
        rowKey={(r) => r.ticketRef}
        empty="No escalations. When a customer asks for a person, the request shows up here."
        columns={[
          { key: "ref", label: "Ticket", className: "mono", cell: (r) => r.ticketRef },
          { key: "biz", label: "Business", cell: (r) => r.businessName },
          {
            key: "when",
            label: "Opened",
            className: "nowrap",
            cell: (r) => formatDateTimeZoned(r.createdAt),
          },
          { key: "why", label: "Reason", cell: (r) => humanizeKey(r.reason) },
          {
            key: "sum",
            label: "Summary",
            className: "wrap",
            cell: (r) => <span className="clamp-3">{r.summary}</span>,
          },
          {
            key: "contact",
            label: "Contact",
            cell: (r) =>
              r.contactEmailMasked ? (
                <span className="nowrap">{r.contactEmailMasked}</span>
              ) : (
                <span className="muted">Not shared</span>
              ),
          },
          { key: "status", label: "Status", cell: (r) => <StatusBadge status={r.status} /> },
          {
            key: "tx",
            label: "Conversation",
            cell: (r) => <TranscriptButton id={r.conversationId} onOpen={onOpen} />,
          },
        ]}
      />
    </Card>
  );
}

const IN_STOCK_PREVIEW = 8;

function InventoryView({ items }: { items: OwnerInventoryItem[] }) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...items].sort((a, b) => {
    const rank = { out: 0, low: 1, in_stock: 2 } as const;
    return rank[a.stock] - rank[b.stock] || a.sku.localeCompare(b.sku);
  });
  const out = items.filter((i) => i.stock === "out").length;
  const low = items.filter((i) => i.stock === "low").length;
  const problems = out + low;
  // VIS-16: problems first; healthy rows behind "Show all" so the table stays scannable.
  const visible =
    showAll || sorted.length <= problems + IN_STOCK_PREVIEW
      ? sorted
      : sorted.slice(0, problems + IN_STOCK_PREVIEW);
  const hidden = sorted.length - visible.length;
  return (
    <Card
      title="Inventory"
      sub={`${out} out of stock · ${low} running low · ${items.length} products`}
    >
      <DataTable
        caption="Inventory, out-of-stock and low-stock first"
        rows={visible}
        rowKey={(r) => `${r.businessId}-${r.sku}`}
        rowAttrs={(r) => ({ "data-stock": r.stock === "in_stock" ? undefined : r.stock })}
        empty="No products for this business. Service businesses don't carry inventory."
        columns={[
          { key: "sku", label: "SKU", className: "mono", cell: (r) => r.sku },
          { key: "name", label: "Product", cell: (r) => r.name },
          { key: "biz", label: "Business", cell: (r) => r.businessName },
          { key: "cat", label: "Category", cell: (r) => r.category },
          {
            key: "price",
            label: "Price",
            className: "num",
            cell: (r) => formatCents(r.priceCents),
          },
          { key: "qty", label: "On hand", className: "num", cell: (r) => formatInt(r.qtyOnHand) },
          {
            key: "stock",
            label: "Stock",
            cell: (r) =>
              r.stock === "out" ? (
                <span className="badge badge--attention">Out of stock</span>
              ) : r.stock === "low" ? (
                <span className="stock-low">
                  <span className="stock-low__dot" aria-hidden="true" />
                  Running low
                </span>
              ) : (
                <span className="muted">In stock</span>
              ),
          },
        ]}
      />
      {(hidden > 0 || showAll) && sorted.length > problems + IN_STOCK_PREVIEW && (
        <div className="surface-card__foot">
          <button
            type="button"
            className="btn btn--secondary btn--small"
            aria-expanded={showAll}
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll
              ? "Show fewer"
              : `Show all ${sorted.length} products (${hidden} more in stock)`}
          </button>
        </div>
      )}
    </Card>
  );
}

function AvailabilityView({ items }: { items: OwnerAvailability[] }) {
  if (items.length === 0) {
    return (
      <Card title="Availability">
        <p className="table-empty">
          No schedules for this business. Only service businesses take appointments.
        </p>
      </Card>
    );
  }
  const byBiz = new Map<string, OwnerAvailability[]>();
  for (const row of items)
    byBiz.set(row.businessName, [...(byBiz.get(row.businessName) ?? []), row]);
  return (
    <>
      {[...byBiz.entries()].map(([name, rows]) => (
        <Card key={name} title={name} sub="Open one-hour start times, next 14 days">
          <div className="avail">
            {rows.map((r) => (
              <div className="avail__row" key={r.contractorId}>
                <p className="avail__who">
                  {r.contractor}{" "}
                  <span>· {formatInt(r.days.reduce((n, d) => n + d.open, 0))} open</span>
                </p>
                <ul
                  className="avail__days"
                  role="list"
                  aria-label={`${r.contractor}, open slots by day`}
                >
                  {r.days.map((d) => {
                    const total = d.open + d.booked + d.held;
                    const level = total === 0 ? "closed" : d.open === 0 ? "none" : "open";
                    return (
                      <li key={d.date} className="avail__day" data-level={level}>
                        <span aria-hidden="true">{formatIsoDateShort(d.date).slice(0, 3)}</span>
                        <span aria-hidden="true">{Number(d.date.slice(8))}</span>
                        <b aria-hidden="true">{total === 0 ? "—" : d.open}</b>
                        <span className="visually-hidden">
                          {formatIsoDateShort(d.date)}:{" "}
                          {total === 0
                            ? "closed"
                            : `${d.open} open, ${d.booked} booked, ${d.held} held`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          <p className="avail__legend">
            Numbers are open start times. <b>0</b> means fully booked; — means closed.
          </p>
        </Card>
      ))}
    </>
  );
}

function NotificationsView({ items }: { items: OwnerNotification[] }) {
  return (
    <Card title="Notifications" sub="Emails and texts sent (or mocked) by Oasis">
      <DataTable
        caption="Notification log"
        rows={items}
        rowKey={(r) => r.id}
        empty="No notifications yet. Confirmations and escalations show up here."
        columns={[
          { key: "when", label: "Sent", cell: (r) => formatDateTimeZoned(r.createdAt) },
          { key: "biz", label: "Business", cell: (r) => r.businessName },
          { key: "ch", label: "Channel", cell: (r) => (r.channel === "sms" ? "SMS" : "Email") },
          { key: "aud", label: "To", cell: (r) => `${cap(r.audience)} · ${r.toMasked}` },
          { key: "subj", label: "Subject", cell: (r) => r.subject ?? "—" },
          { key: "ref", label: "Reference", className: "mono", cell: (r) => r.relatedRef ?? "—" },
          {
            key: "status",
            label: "Status",
            cell: (r) => (
              <>
                <StatusBadge status={r.status} />
                {r.error && <span className="visually-hidden">: {r.error}</span>}
              </>
            ),
          },
        ]}
      />
    </Card>
  );
}

const OUTCOME_LABEL: Record<OwnerConversation["outcome"], string> = {
  none: "No sale yet",
  order: "Ordered",
  booking: "Booked",
  escalated: "Escalated",
};

function ConversationsView({
  items,
  onOpen,
}: {
  items: OwnerConversation[];
  onOpen: OpenTranscript;
}) {
  return (
    <Card
      title="Conversations"
      sub="Open a transcript to read what was said. Emails and phone numbers are masked."
    >
      <DataTable
        caption="Conversations"
        rows={items}
        rowKey={(r) => r.id}
        empty="No conversations yet."
        columns={[
          { key: "last", label: "Last active", cell: (r) => formatDateTimeZoned(r.lastActiveAt) },
          { key: "biz", label: "Business", cell: (r) => r.businessName },
          {
            key: "msgs",
            label: "Messages",
            className: "num",
            cell: (r) => formatInt(r.messageCount),
          },
          {
            key: "tok",
            label: "Tokens in / out",
            className: "num",
            cell: (r) => `${formatInt(r.inputTokens)} / ${formatInt(r.outputTokens)}`,
          },
          {
            key: "cost",
            label: "Cost",
            className: "num",
            cell: (r) => formatUsdAmount(r.costUsd, 4),
          },
          {
            key: "out",
            label: "Outcome",
            cell: (r) => (
              <span className={`badge ${r.outcome === "escalated" ? "badge--attention" : ""}`}>
                {OUTCOME_LABEL[r.outcome]}
              </span>
            ),
          },
          {
            key: "tx",
            label: "Transcript",
            cell: (r) => <TranscriptButton id={r.id} onOpen={onOpen} />,
          },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Transcript drawer (native modal <dialog>: focus trap, Escape, inert background)
// ---------------------------------------------------------------------------

type TranscriptState =
  | { status: "loading"; id: string }
  | { status: "error"; id: string; message: string }
  | { status: "ready"; id: string; data: OwnerTranscript };

function TranscriptDrawer({
  state,
  dialogRef,
  onClose,
  onRetry,
}: {
  state: TranscriptState | null;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <dialog
      ref={dialogRef}
      className="sheet transcript"
      aria-labelledby="transcript-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="sheet__grip" aria-hidden="true" />
      <div className="transcript__bar">
        <div>
          <h2 id="transcript-title" className="transcript__title">
            Conversation transcript
          </h2>
          {state?.status === "ready" && (
            <p className="transcript__sub">
              {state.data.businessName} · {state.data.messages.length} message
              {state.data.messages.length === 1 ? "" : "s"}
            </p>
          )}
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close transcript"
          onClick={() => dialogRef.current?.close()}
        >
          <IconClose />
        </button>
      </div>
      <div className="sheet__content transcript__body">
        {!state || state.status === "loading" ? (
          <div className="loading-row" role="status">
            <span className="spinner" aria-hidden="true" /> Loading transcript…
          </div>
        ) : state.status === "error" ? (
          <div className="notice notice--danger" role="alert">
            <IconAlert />
            <div className="notice__body">
              <span>{state.message}</span>
              <div>
                <button type="button" className="btn btn--secondary btn--small" onClick={onRetry}>
                  Try again
                </button>
              </div>
            </div>
          </div>
        ) : state.data.messages.length === 0 ? (
          <p className="table-empty">No messages were stored for this conversation.</p>
        ) : (
          <>
            <p className="transcript__note">
              Oldest first. Card numbers are removed; emails and phone numbers are masked.
            </p>
            <ol className="transcript__list" role="list">
              {state.data.messages.map((m, i) => (
                <li key={i} className="transcript__msg" data-role={m.role}>
                  <p className="transcript__meta">
                    <b>{m.role === "user" ? "Customer" : "Assistant"}</b>
                    <span>{formatDateTimeZoned(m.createdAt)}</span>
                  </p>
                  <p className="transcript__text">
                    {splitEmails(m.text).map((p, j) =>
                      p.email ? (
                        <span key={j} className="email">
                          {p.text}
                        </span>
                      ) : (
                        p.text
                      ),
                    )}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------

export function OwnerDashboard({ businesses }: { businesses: BizOption[] }) {
  const router = useRouter();
  const wide = useMediaQuery(WIDE_TABS_QUERY);
  const [tab, setTab] = useState<TabKey>("overview");
  const [biz, setBiz] = useState("all");
  const [state, setState] = useState<Partial<{ [K in TabKey]: LoadState<Data[K]> }>>({});
  const [signingOut, setSigningOut] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptState | null>(null);
  const tabRefs = useRef<Partial<Record<TabKey, HTMLButtonElement | null>>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);
  const transcriptTrigger = useRef<HTMLElement | null>(null);

  const load = useCallback(
    async (key: TabKey) => {
      const ep = ENDPOINTS[key];
      const res = await apiRequest(ep.path, ep.schema as z.ZodType<Data[typeof key]>);
      if (!res.ok && res.status === 401) {
        router.replace("/owner/login");
        return;
      }
      setState((s) => ({
        ...s,
        [key]: res.ok
          ? { status: "ready", data: res.data }
          : {
              status: "error",
              message:
                res.kind === "network"
                  ? "We couldn't reach Oasis. Check your connection."
                  : "This view couldn't load. Try again.",
            },
      }));
    },
    [router],
  );

  // Deep-link: #orders etc.
  useEffect(() => {
    const hash = window.location.hash.slice(1) as TabKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the URL hash once on mount
    if (hash in ENDPOINTS) setTab(hash);
  }, []);

  // Each view is fetched once, the first time it is shown (the overview always, for its banner).
  const requested = useRef(new Set<TabKey>());
  useEffect(() => {
    for (const key of new Set<TabKey>(["overview", tab])) {
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      void load(key);
    }
  }, [tab, load]);

  const retry = (key: TabKey) => {
    setState((s) => ({ ...s, [key]: { status: "loading" } }));
    void load(key);
  };

  const selectTab = (key: TabKey, focus = false) => {
    setTab(key);
    try {
      history.replaceState(null, "", key === "overview" ? window.location.pathname : `#${key}`);
    } catch {
      // ignore
    }
    const el = tabRefs.current[key];
    if (focus) el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next >= 0) {
      e.preventDefault();
      selectTab(TABS[next]!.key, true);
    }
  };

  // ---- Transcript viewer ---------------------------------------------------
  const fetchTranscript = useCallback(
    async (id: string) => {
      setTranscript({ status: "loading", id });
      const res = await apiRequest(ownerTranscriptPath(id), OwnerTranscript);
      if (!res.ok && res.status === 401) {
        router.replace("/owner/login");
        return;
      }
      setTranscript((cur) =>
        cur?.id !== id
          ? cur
          : res.ok
            ? { status: "ready", id, data: res.data }
            : {
                status: "error",
                id,
                message:
                  res.status === 404
                    ? "This conversation is no longer stored."
                    : res.kind === "network"
                      ? "We couldn't reach Oasis. Check your connection."
                      : "The transcript couldn't load. Try again.",
              },
      );
    },
    [router],
  );
  const openTranscript: OpenTranscript = (id, trigger) => {
    transcriptTrigger.current = trigger;
    void fetchTranscript(id);
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  };
  const onTranscriptClose = () => {
    setTranscript(null);
    const back = transcriptTrigger.current;
    if (back?.isConnected) requestAnimationFrame(() => back.focus());
  };

  const signOut = async () => {
    setSigningOut(true);
    await ownerLogout();
    router.replace("/owner/login");
    router.refresh();
  };

  const overview = state.overview?.status === "ready" ? state.overview.data : null;
  const filter = <T extends { businessId: string }>(rows: T[]) =>
    biz === "all" ? rows : rows.filter((r) => r.businessId === biz);

  const current = state[tab];
  let body: ReactNode;
  if (!current || current.status === "loading" || current.status === "idle") {
    body = (
      <div className="loading-row" role="status">
        <span className="spinner" aria-hidden="true" /> Loading…
      </div>
    );
  } else if (current.status === "error") {
    body = (
      <div className="notice notice--danger" role="alert">
        <IconAlert />
        <div className="notice__body">
          <span>{current.message}</span>
          <div>
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={() => retry(tab)}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  } else {
    const d = (current as { status: "ready"; data: Data[TabKey] }).data;
    switch (tab) {
      case "overview":
        body = <OverviewView data={d as OwnerOverview} biz={biz} />;
        break;
      case "orders":
        body = <OrdersView items={filter((d as Data["orders"]).items)} />;
        break;
      case "bookings":
        body = <BookingsView items={filter((d as Data["bookings"]).items)} />;
        break;
      case "escalations":
        body = (
          <EscalationsView
            items={filter((d as Data["escalations"]).items)}
            onOpen={openTranscript}
          />
        );
        break;
      case "inventory":
        body = <InventoryView items={filter((d as Data["inventory"]).items)} />;
        break;
      case "availability":
        body = <AvailabilityView items={filter((d as Data["availability"]).items)} />;
        break;
      case "notifications":
        body = <NotificationsView items={filter((d as Data["notifications"]).items)} />;
        break;
      case "conversations":
        body = (
          <ConversationsView
            items={filter((d as Data["conversations"]).items)}
            onOpen={openTranscript}
          />
        );
        break;
    }
  }

  const tabLabel = TABS.find((t) => t.key === tab)?.label ?? "";

  return (
    <div className="owner-shell">
      <header className="site-header">
        <div className="container site-header__inner">
          <BrandLink />
          <div className="owner-header-actions">
            <span className="badge">Owner</span>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => void signOut()}
              disabled={signingOut}
            >
              <IconSignOut className="btn__icon" />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="container">
        <div className="owner-top">
          <div>
            <h1>Dashboard</h1>
            <p>Everything the agents sold, booked and said, across all five businesses.</p>
          </div>
          <div className="owner-controls">
            {!wide && (
              <div className="owner-filter">
                <label htmlFor="view-select" className="field__label">
                  View
                </label>
                <select
                  id="view-select"
                  className="select"
                  value={tab}
                  onChange={(e) => selectTab(e.target.value as TabKey)}
                >
                  {TABS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="owner-filter">
              <label htmlFor="biz-filter" className="field__label">
                Business
              </label>
              <select
                id="biz-filter"
                className="select"
                value={biz}
                onChange={(e) => setBiz(e.target.value)}
              >
                <option value="all">All businesses</option>
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {overview?.demoCredentials && (
          <div className="notice notice--warn owner-banner" role="note">
            <IconAlert />
            <span>
              <strong>Demo credentials in use.</strong> This dashboard is protected by the
              documented demo secrets
              {overview.demoSecrets.length > 0 && (
                <>
                  {" "}
                  (
                  {overview.demoSecrets.map((s, i) => (
                    <span key={s}>
                      {i > 0 && ", "}
                      <code>{s}</code>
                    </span>
                  ))}
                  )
                </>
              )}
              . Set your own before sharing it.
            </span>
          </div>
        )}

        {wide ? (
          <>
            <div className="tabs" role="tablist" aria-label="Dashboard views">
              {TABS.map((t, i) => (
                <button
                  key={t.key}
                  ref={(el) => {
                    tabRefs.current[t.key] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`tab-${t.key}`}
                  className="tab"
                  aria-selected={tab === t.key}
                  aria-controls={tab === t.key ? `panel-${t.key}` : undefined}
                  tabIndex={tab === t.key ? 0 : -1}
                  onClick={() => selectTab(t.key)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id={`panel-${tab}`}
              aria-labelledby={`tab-${tab}`}
              tabIndex={0}
              className="tabpanel"
            >
              {body}
            </div>
          </>
        ) : (
          <section id={`panel-${tab}`} aria-label={tabLabel} className="tabpanel">
            {body}
          </section>
        )}
      </main>
      <TranscriptDrawer
        state={transcript}
        dialogRef={dialogRef}
        onClose={onTranscriptClose}
        onRetry={() => transcript && void fetchTranscript(transcript.id)}
      />
    </div>
  );
}
