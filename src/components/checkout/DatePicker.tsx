"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatIsoDateLong } from "@/ui-lib/format";
import { IconChevronLeft, IconChevronRight } from "../icons";

/**
 * Accessible month calendar restricted to `available` dates (WAI-ARIA date picker grid
 * pattern). Roving tabindex: one day is tabbable; arrows move by day/week, Home/End to
 * week start/end, PageUp/PageDown by month. Unavailable days stay focusable (so arrows
 * never get stuck) but are aria-disabled and cannot be chosen.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function toUtc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}
function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(date: string, n: number): string {
  return fromUtc(toUtc(date) + n * DAY_MS);
}
function monthKey(date: string): string {
  return date.slice(0, 7);
}
function addMonths(date: string, n: number): string {
  const d = new Date(toUtc(date));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fromUtc(d.getTime());
}
function clamp(date: string, min: string, max: string): string {
  return date < min ? min : date > max ? max : date;
}
function monthLabel(key: string): string {
  return new Date(`${key}-01T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

export interface DatePickerProps {
  id: string;
  labelledBy: string;
  describedBy?: string;
  min: string;
  max: string;
  available: readonly string[];
  value: string | null;
  onChange: (date: string) => void;
}

export function DatePicker({
  id,
  labelledBy,
  describedBy,
  min,
  max,
  available,
  value,
  onChange,
}: DatePickerProps) {
  const availableSet = useMemo(() => new Set(available), [available]);
  const firstAvailable = available.find((d) => d >= min && d <= max) ?? min;
  const [focusDate, setFocusDate] = useState<string>(value ?? firstAvailable);
  const [prevValue, setPrevValue] = useState(value);
  const shouldFocus = useRef(false);
  const gridRef = useRef<HTMLTableElement>(null);

  // Keep the visible month in sync when the selected value changes from outside.
  if (value !== prevValue) {
    setPrevValue(value);
    if (value) setFocusDate(value);
  }

  useEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus();
  }, [focusDate]);

  const month = monthKey(focusDate);
  const firstOfMonth = `${month}-01`;
  const startOffset = new Date(toUtc(firstOfMonth)).getUTCDay();
  const gridStart = addDays(firstOfMonth, -startOffset);
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) week.push(addDays(gridStart, w * 7 + d));
    if (w > 3 && week.every((day) => monthKey(day) !== month)) break;
    weeks.push(week);
  }

  const canPrev = monthKey(min) < month;
  const canNext = monthKey(max) > month;

  const move = (next: string) => {
    shouldFocus.current = true;
    setFocusDate(clamp(next, min, max));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const dow = new Date(toUtc(date)).getUTCDay();
    let next: string | null = null;
    switch (e.key) {
      case "ArrowLeft":
        next = addDays(date, -1);
        break;
      case "ArrowRight":
        next = addDays(date, 1);
        break;
      case "ArrowUp":
        next = addDays(date, -7);
        break;
      case "ArrowDown":
        next = addDays(date, 7);
        break;
      case "Home":
        next = addDays(date, -dow);
        break;
      case "End":
        next = addDays(date, 6 - dow);
        break;
      case "PageUp":
        next = addMonths(date, -1);
        break;
      case "PageDown":
        next = addMonths(date, 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    move(next);
  };

  const goMonth = (n: number) => {
    const target = clamp(addMonths(focusDate, n), min, max);
    // Land on the first available day of that month when there is one.
    const firstInMonth = available.find((d) => monthKey(d) === monthKey(target));
    setFocusDate(firstInMonth ?? target);
  };

  const label = monthLabel(month);
  const monthHasAvailability = available.some((d) => monthKey(d) === month);

  return (
    <div className="cal" id={id}>
      <div className="cal__head">
        <h3 className="cal__month" id={`${id}-month`} aria-live="polite">
          {label}
        </h3>
        <div className="cal__nav">
          <button
            type="button"
            className="icon-btn"
            onClick={() => goMonth(-1)}
            disabled={!canPrev}
            aria-label="Previous month"
          >
            <IconChevronLeft />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => goMonth(1)}
            disabled={!canNext}
            aria-label="Next month"
          >
            <IconChevronRight />
          </button>
        </div>
      </div>
      <table
        ref={gridRef}
        className="cal__grid"
        role="grid"
        aria-labelledby={`${labelledBy} ${id}-month`}
        aria-describedby={describedBy}
      >
        <thead>
          <tr>
            {WEEKDAYS.map((d, i) => (
              <th key={d} scope="col" abbr={WEEKDAYS_LONG[i]}>
                {d.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((date) => {
                const inMonth = monthKey(date) === month;
                if (!inMonth) return <td key={date} role="gridcell" />;
                const inRange = date >= min && date <= max;
                const isAvailable = inRange && availableSet.has(date);
                const selected = value === date;
                return (
                  <td key={date} role="gridcell" aria-selected={selected}>
                    <button
                      type="button"
                      className="cal__day"
                      data-date={date}
                      data-available={isAvailable}
                      data-selected={selected}
                      aria-disabled={!isAvailable || undefined}
                      aria-label={`${formatIsoDateLong(date)}${isAvailable ? ", has openings" : ", no openings"}`}
                      tabIndex={date === focusDate ? 0 : -1}
                      onClick={() => {
                        setFocusDate(date);
                        if (isAvailable) onChange(date);
                      }}
                      onKeyDown={(e) => onKeyDown(e, date)}
                    >
                      {Number(date.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cal__legend">
        <span>
          <span className="cal__swatch" aria-hidden="true" />
          <span>
            <b>Bold</b> days have openings
          </span>
        </span>
        {!monthHasAvailability && <span>No openings this month</span>}
      </div>
    </div>
  );
}
