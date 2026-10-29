/** Fixed (non-env) operational constants from SPEC §8. */

/** Checkout draft time-to-live. */
export const CHECKOUT_DRAFT_TTL_MIN = 30;

/** Rate-limit window for chat messages per IP. */
export const RATE_LIMIT_CHAT_WINDOW_MS = 10 * 60 * 1000;

/** Rate-limit window for generic API requests per IP. */
export const RATE_LIMIT_API_WINDOW_MS = 60 * 1000;

/** How many days ahead availability is generated / bookable. */
export const BOOKING_HORIZON_DAYS = 60;

/** Slot granularity in minutes (one Slot row = one start position). */
export const SLOT_MINUTES = 60;

/** Order / booking reference format `OAS-XXXX-XXXX` (Crockford-ish alphabet, no 0/O/1/I). */
export const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const REFERENCE_PATTERN = /^OAS-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
