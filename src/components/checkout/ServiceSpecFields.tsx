"use client";

import { useId, type ReactNode } from "react";
import type { ServiceConfig, ServiceOptions } from "@/contracts";
import {
  chooseExclusive,
  chooseTier,
  includedInTier,
  qtyOf,
  setAddOn,
  setSurcharge,
} from "@/ui-lib/service-config";
import { IconMinus, IconPlus } from "../icons";

/**
 * Every option of one service (tier, exclusive add-on groups, extras, conditions, frequency)
 * as native radios, checkboxes and steppers, so keyboard and screen-reader behaviour is the
 * platform's own. Labels and per-option prices come from the server (ServiceOptions); the
 * total is never computed here.
 *
 * Shared by the in-chat service card and the booking form's "Service details".
 */
export interface ServiceSpecFieldsProps {
  options: ServiceOptions;
  value: ServiceConfig;
  onChange: (next: ServiceConfig) => void;
  /** Disable every control (e.g. a card that is no longer the latest). */
  disabled?: boolean;
}

export function Stepper({
  id,
  label,
  value,
  min = 0,
  max,
  step = 1,
  unit,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="stepper" role="group" aria-labelledby={`${id}-label`}>
      <span className="visually-hidden" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        className="stepper__btn"
        aria-label={`Fewer: ${label}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - step))}
      >
        <IconMinus />
      </button>
      <output className="stepper__value tabular" aria-live="polite">
        {value}
        {unit ? <span className="stepper__unit"> {unit}</span> : null}
      </output>
      <button
        type="button"
        className="stepper__btn"
        aria-label={`More: ${label}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + step))}
      >
        <IconPlus />
      </button>
    </div>
  );
}

function Group({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="spec__group">
      <legend className="spec__legend">{legend}</legend>
      {hint && <p className="spec__hint">{hint}</p>}
      {children}
    </fieldset>
  );
}

export function ServiceSpecFields({ options, value, onChange, disabled }: ServiceSpecFieldsProps) {
  const uid = useId().replace(/:/g, "");
  const fid = (s: string) => `${uid}-${s}`;
  const tier = options.tiers.find((t) => t.code === value.tierCode) ?? options.tiers[0]!;
  const exclusive = options.addOnGroups.filter((g) => g.exclusive);
  const extras = options.addOnGroups.filter((g) => !g.exclusive);

  return (
    <div className="spec">
      <Group legend={options.tierLabel}>
        <div className="spec-tiles">
          {options.tiers.map((t) => (
            <label className="spec-tile" key={t.code}>
              <input
                type="radio"
                name={fid("tier")}
                value={t.code}
                checked={t.code === tier.code}
                disabled={disabled}
                onChange={() => onChange(chooseTier(options, value, t.code))}
              />
              <span className="spec-tile__body">
                <span className="spec-tile__name">{t.name}</span>
                <span className="spec-tile__meta">
                  From {t.priceLabel} · {t.durationLabel.replace(/^About /, "")}
                </span>
                {t.crewLabel && <span className="spec-tile__meta">{t.crewLabel}</span>}
              </span>
            </label>
          ))}
        </div>
        {tier.extraUnit && (
          <div className="spec-row spec-row--static">
            <span className="spec-row__text">
              <span className="spec-row__name">Each {tier.extraUnit.name}</span>
              <span className="spec-row__meta">{tier.extraUnit.priceLabel}</span>
            </span>
            <Stepper
              id={fid("extra")}
              label={`${tier.extraUnit.name}s`}
              value={value.extraUnits}
              max={tier.extraUnit.maxQty}
              disabled={disabled}
              onChange={(n) => onChange({ ...value, extraUnits: n })}
            />
          </div>
        )}
      </Group>

      {exclusive.map((g) => {
        const chosen = g.items.find((i) => qtyOf(value.addOns, i.code) > 0)?.code ?? null;
        return (
          <Group legend={g.label} key={g.key}>
            <div className="spec-choices">
              {[{ code: null, name: g.noneLabel ?? "None", priceLabel: "" }, ...g.items].map(
                (i) => (
                  <label className="spec-choice" key={i.code ?? "none"}>
                    <input
                      type="radio"
                      name={fid(`g-${g.key}`)}
                      value={i.code ?? ""}
                      checked={chosen === i.code}
                      disabled={disabled}
                      onChange={() => onChange(chooseExclusive(options, value, g.key, i.code))}
                    />
                    <span className="spec-choice__body">
                      <span className="spec-choice__name">{i.name}</span>
                      {i.priceLabel && <span className="spec-choice__meta">{i.priceLabel}</span>}
                    </span>
                  </label>
                ),
              )}
            </div>
          </Group>
        );
      })}

      {extras.map((g) => (
        <Group legend={g.label} key={g.key}>
          <ul className="spec-rows" role="list">
            {g.items.map((i) => {
              const qty = qtyOf(value.addOns, i.code);
              const included = includedInTier(i, value);
              const meta = included
                ? "Included"
                : [i.priceLabel, i.timeLabel].filter(Boolean).join(" · ");
              if (i.maxQty > 1) {
                return (
                  <li className="spec-row spec-row--static" key={i.code}>
                    <span className="spec-row__text">
                      <span className="spec-row__name">{i.name}</span>
                      <span className="spec-row__meta">{meta}</span>
                    </span>
                    <Stepper
                      id={fid(`a-${i.code}`)}
                      label={i.name}
                      value={qty}
                      max={i.maxQty}
                      disabled={disabled}
                      onChange={(n) => onChange(setAddOn(value, i.code, n))}
                    />
                  </li>
                );
              }
              return (
                <li key={i.code}>
                  <label className="spec-row">
                    <input
                      type="checkbox"
                      checked={included || qty > 0}
                      disabled={disabled || included}
                      onChange={(e) => onChange(setAddOn(value, i.code, e.target.checked ? 1 : 0))}
                    />
                    <span className="spec-row__text">
                      <span className="spec-row__name">{i.name}</span>
                      <span className="spec-row__meta">{meta}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </Group>
      ))}

      {options.surcharges.length > 0 && (
        <Group legend={options.surchargeLabel} hint="Tick any that apply, so the price is right.">
          <ul className="spec-rows" role="list">
            {options.surcharges.map((s) => {
              const qty = qtyOf(value.surcharges, s.code);
              const meta = [s.priceLabel, s.timeLabel].filter(Boolean).join(" · ");
              return (
                <li className="spec-cond" key={s.code}>
                  {s.perUnit ? (
                    <div className="spec-row spec-row--static">
                      <span className="spec-row__text">
                        <span className="spec-row__name">{s.name}</span>
                        <span className="spec-row__meta">{meta}</span>
                      </span>
                      <Stepper
                        id={fid(`s-${s.code}`)}
                        label={`${s.name}, ${s.perUnit.unitLabel}`}
                        value={qty}
                        max={s.perUnit.maxQty}
                        step={100}
                        unit="sq ft"
                        disabled={disabled}
                        onChange={(n) => onChange(setSurcharge(options, value, s.code, n))}
                      />
                    </div>
                  ) : (
                    <label className="spec-row">
                      <input
                        type="checkbox"
                        checked={qty > 0}
                        disabled={disabled}
                        onChange={(e) =>
                          onChange(setSurcharge(options, value, s.code, e.target.checked ? 1 : 0))
                        }
                      />
                      <span className="spec-row__text">
                        <span className="spec-row__name">{s.name}</span>
                        <span className="spec-row__meta">{meta}</span>
                        <span className="spec-row__desc">{s.condition}</span>
                      </span>
                    </label>
                  )}
                  <details className="spec-why">
                    <summary>Why does this cost more?</summary>
                    <p>
                      {s.explanation}
                      {s.confirmOnSite ? " The crew confirms this on arrival." : ""}
                    </p>
                  </details>
                </li>
              );
            })}
          </ul>
        </Group>
      )}

      {options.frequencies.length > 1 && (
        <Group
          legend="How often"
          hint="Recurring discounts apply to the base visit only, not to extras or conditions."
        >
          <div className="spec-choices">
            {options.frequencies.map((f) => (
              <label className="spec-choice" key={f.code}>
                <input
                  type="radio"
                  name={fid("freq")}
                  value={f.code}
                  checked={value.frequency === f.code}
                  disabled={disabled}
                  onChange={() => onChange({ ...value, frequency: f.code })}
                />
                <span className="spec-choice__body">
                  <span className="spec-choice__name">{f.name}</span>
                  {f.discountLabel && <span className="spec-choice__meta">{f.discountLabel}</span>}
                </span>
              </label>
            ))}
          </div>
        </Group>
      )}
    </div>
  );
}
