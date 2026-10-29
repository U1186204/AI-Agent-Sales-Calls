"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The frame every chat card shares with the secure checkout card (same `.checkout` surface,
 * header, eyebrow and body), so the guided flow and the booking form read as one system.
 */
export function CardShell({
  label,
  eyebrow,
  icon,
  title,
  subtitle,
  autoFocus,
  inactive,
  children,
}: {
  /** Accessible name of the card region. */
  label: string;
  eyebrow: string;
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  /** Move focus to the title on mount (the card answers a click in the previous card). */
  autoFocus?: boolean;
  /** An older card: read-only, visually quieter. */
  inactive?: boolean;
  children: ReactNode;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusOnce = useRef(autoFocus);
  useEffect(() => {
    if (!focusOnce.current) return;
    focusOnce.current = false;
    titleRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      className={`checkout chat-card${inactive ? " chat-card--inactive" : ""}`}
      aria-label={label}
    >
      <div className="checkout__head chat-card__head">
        <p className="checkout__eyebrow">
          {icon}
          {eyebrow}
        </p>
        <h2 className="checkout__title" ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        {subtitle && <p className="checkout__summary">{subtitle}</p>}
      </div>
      <div className="checkout__body chat-card__body">{children}</div>
    </section>
  );
}
