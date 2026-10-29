"use client";

import { useId, useState } from "react";
import type { CardAction, ServiceConfig, ServiceOptions, UiBlock } from "@/contracts";
import { formatDuration, formatIsoDateLong, isoDateInTz, timezoneName } from "@/ui-lib/format";
import { configSummary, defaultConfig, sanitizeConfig } from "@/ui-lib/service-config";
import { QuoteSummary } from "../../checkout/QuoteSummary";
import { ServiceSpecFields } from "../../checkout/ServiceSpecFields";
import { IconAlert, IconCalendar, IconInfo, IconPerson, IconTag } from "../../icons";
import { CardShell } from "./CardShell";

type Block<T extends UiBlock["type"]> = Extract<UiBlock, { type: T }>;

export interface CardProps<T extends UiBlock["type"]> {
  block: Block<T>;
  /** Only the newest card of its kind takes clicks; older ones are read-only. */
  active: boolean;
  autoFocus?: boolean;
  /** Send a card action; `label` is the customer's choice as shown in the conversation. */
  onAction: (action: CardAction, label: string) => void;
}

const optionsFor = (services: readonly ServiceOptions[], code: string) =>
  services.find((s) => s.serviceCode === code) ?? services[0]!;

// ---------------------------------------------------------------------------
// Service picker
// ---------------------------------------------------------------------------

export function ServicePickerCard({
  block,
  active,
  autoFocus,
  onAction,
}: CardProps<"service_picker">) {
  const uid = useId().replace(/:/g, "");
  const multi = block.services.length > 1;
  const [config, setConfig] = useState<ServiceConfig>(() => {
    const first = block.selected
      ? optionsFor(block.services, block.selected.serviceCode)
      : block.services[0]!;
    return block.selected ? sanitizeConfig(first, block.selected) : defaultConfig(first);
  });
  const options = optionsFor(block.services, config.serviceCode);

  const chooseService = (code: string) =>
    setConfig((prev) => {
      const next = optionsFor(block.services, code);
      return sanitizeConfig(next, { ...prev, serviceCode: next.serviceCode });
    });

  return (
    <CardShell
      label={multi ? "Choose your service" : `${options.name} options`}
      eyebrow="Build your quote"
      icon={<IconTag />}
      title={multi ? "Choose your service" : options.name}
      subtitle={
        multi ? "Pick a type, then the details. Prices update when you ask." : options.description
      }
      autoFocus={autoFocus}
      inactive={!active}
    >
      {multi && (
        <fieldset className="spec__group">
          <legend className="spec__legend">Type of service</legend>
          <div className="spec-choices">
            {block.services.map((s) => (
              <label className="spec-choice" key={s.serviceCode}>
                <input
                  type="radio"
                  name={`${uid}-service`}
                  value={s.serviceCode}
                  checked={s.serviceCode === options.serviceCode}
                  disabled={!active}
                  onChange={() => chooseService(s.serviceCode)}
                />
                <span className="spec-choice__body">
                  <span className="spec-choice__name">{s.name}</span>
                  <span className="spec-choice__meta">{s.fromLabel}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <details className="spec-why chat-card__includes">
        <summary>What&apos;s included{multi ? ` in ${options.name.toLowerCase()}` : ""}</summary>
        <ul>
          {options.includes.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </details>
      <ServiceSpecFields
        key={options.serviceCode}
        options={options}
        value={config}
        onChange={setConfig}
        disabled={!active}
      />
      <div className="checkout__actions">
        <button
          type="button"
          className="btn"
          disabled={!active}
          onClick={() =>
            onAction(
              { action: "get_quote", config },
              `Price for ${options.name}: ${configSummary(options, config)}`,
            )
          }
        >
          See price and times
        </button>
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export function QuoteCard({ block, active, autoFocus, onAction }: CardProps<"quote_card">) {
  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState<ServiceConfig>(() =>
    sanitizeConfig(block.options, block.config),
  );
  const extras = configSummary(block.options, block.config).split(" · ").slice(1).join(" · ");
  return (
    <CardShell
      label={`Price for ${block.serviceName}`}
      eyebrow="Your price"
      icon={<IconTag />}
      title={`${block.serviceName} · ${block.tierName}`}
      subtitle={[extras, `About ${formatDuration(block.durationMin)}`].filter(Boolean).join(" · ")}
      autoFocus={autoFocus}
      inactive={!active}
    >
      {block.warnings.length > 0 && (
        <div className="notice notice--warn">
          <IconInfo />
          <ul className="notice__body">
            {block.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <QuoteSummary quote={block.quote} showShipping={false} compact />
      {editing && active ? (
        <>
          <ServiceSpecFields options={block.options} value={config} onChange={setConfig} />
          <div className="checkout__actions">
            <button type="button" className="btn btn--secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                onAction(
                  { action: "get_quote", config },
                  `Update price: ${configSummary(block.options, config)}`,
                )
              }
            >
              Update price
            </button>
          </div>
        </>
      ) : (
        active && (
          <div className="checkout__actions">
            <button type="button" className="btn btn--secondary" onClick={() => setEditing(true)}>
              Change options
            </button>
          </div>
        )
      )}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Open times
// ---------------------------------------------------------------------------

export function SlotSuggestionsCard({
  block,
  active,
  autoFocus,
  onAction,
}: CardProps<"slot_suggestions">) {
  const tz = block.timezone;
  const days: { date: string; slots: typeof block.slots }[] = [];
  for (const s of block.slots) {
    const date = isoDateInTz(s.startsAt, tz);
    const day = days.find((d) => d.date === date);
    if (day) day.slots.push(s);
    else days.push({ date, slots: [s] });
  }
  return (
    <CardShell
      label={`Open times for ${block.serviceName}`}
      eyebrow="Open times"
      icon={<IconCalendar />}
      title="Pick a time"
      subtitle={`${block.serviceName} · about ${formatDuration(block.durationMin)} · ${timezoneName(tz)}`}
      autoFocus={autoFocus}
      inactive={!active}
    >
      <div className="slot-days">
        {days.map((d) => (
          <div className="slot-day" key={d.date}>
            <h3 className="slot-day__label">{formatIsoDateLong(d.date)}</h3>
            <div className="times">
              {d.slots.map((s) => (
                <button
                  type="button"
                  className="time-btn"
                  key={s.slotId}
                  disabled={!active}
                  aria-label={`${formatIsoDateLong(d.date)} at ${s.localTime}`}
                  onClick={() =>
                    onAction(
                      { action: "pick_slot", config: block.config, slotId: s.slotId },
                      `Book ${formatIsoDateLong(d.date)} at ${s.localTime}`,
                    )
                  }
                >
                  {s.localTime}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="checkout__actions">
        <p className="checkout__fine checkout__fine--grow">
          Picking a time opens the secure booking form. Nothing is booked until you confirm.
        </p>
        {block.moreFrom && (
          <button
            type="button"
            className="btn btn--secondary"
            disabled={!active}
            onClick={() =>
              onAction(
                { action: "more_times", config: block.config, fromDate: block.moreFrom! },
                `More times from ${formatIsoDateLong(block.moreFrom!)}`,
              )
            }
          >
            More times
          </button>
        )}
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// On-site estimate
// ---------------------------------------------------------------------------

export function EstimateCard({
  block,
  active,
  autoFocus,
  onTalk,
}: Omit<CardProps<"estimate_card">, "onAction"> & {
  onTalk: (from: HTMLElement | null) => void;
}) {
  return (
    <CardShell
      label={`On-site estimate for ${block.serviceName}`}
      eyebrow="On-site estimate"
      icon={<IconAlert />}
      title={block.serviceName}
      autoFocus={autoFocus}
      inactive={!active}
    >
      <p className="chat-card__text">{block.reason}</p>
      <div className="checkout__actions">
        <button
          type="button"
          className="btn"
          disabled={!active}
          onClick={(e) => onTalk(e.currentTarget)}
        >
          <IconPerson />
          Talk to a person
        </button>
      </div>
    </CardShell>
  );
}
