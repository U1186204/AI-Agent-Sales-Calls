# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Updated `next`, `zod` and `prisma` (and their transitive `mysql2`, `deepmerge-ts`, `fast-uri`)
  with `npm audit fix`; `npm audit` now reports 0 vulnerabilities. Fixes include a critical
  Next.js advisory (GHSA-673q-mjm6-r5xr) and a high-severity Zod memory exhaustion
  (GHSA-mrhx-c7xc-m3w5).

### Removed

- The earlier Python/Streamlit prototype. The repository is now the Next.js app only.

### Added

- **Guided chat cards.** Replies before checkout come with interactive cards drawn like the
  secure checkout card: a service options picker (every tier, add-on, condition and frequency,
  with "Why does this cost more?" from the business's own explanations), a price card, open
  times, an on-site-estimate card, product cards with live stock and quantity steppers, and a
  priced cart with an optional shipping ZIP. Cards are built by the server from tool output and
  config, never by the model.
- **Card clicks without the model** (`card_action` chat event): codes, quantities and ids only;
  validated against the business's catalog before any tool runs; the same tools as the model;
  one short templated reply and the next card. $0 and instant.
- **"Service details" in the booking form**: see and change the configuration being booked;
  `PATCH /api/checkout/draft/:id/selection` re-prices on the server, re-checks the chosen time
  against the new job length, and is bound to the draft's conversation.
  New env `RATE_LIMIT_DRAFT_EDIT_PER_10MIN` (default 120).
- Prompt rule 14 (brevity) and a card section in the style rules; `reply_long` log signal.
- Test assistant: price/options, next-opening and stock questions now produce cards.
- Tests: unit (service options, draft edits, cards, card actions incl. tampering, the PATCH
  route, reply assembly, config helpers), e2e (`ui-cards`, `ui-service-details`,
  `fullstack-guided` for all five businesses at 375/768/1440), evals (`guided-*`).

- **Payment provider seam** (`src/payments`): a `PaymentProvider` interface (`createIntent`,
  `confirm`, `refund`), the default `NoPaymentProvider` (no network, `not_required`) and
  `getPaymentProvider()`, selected by the new `PAYMENT_PROVIDER` env variable (default `none`;
  any other value stops the server at start with a "not implemented yet" error). Comments mark
  where a Stripe provider (cards and Apple Pay), a client-side payment step and a webhook route
  plug in.
- Checkout error code `payment_failed` (HTTP 402) for a declined payment.
- Reference-number guard: a reference the model never saw is corrected or removed, and a
  confirmed checkout always states the real reference from the database.
- Live-model eval results: 53/53 on `claude-haiku-4-5` (`docs/evals.md`).
- `npm run owner:hash` prompts (twice) when no passphrase is given.

### Changed

- The assistant's reply now includes text written before a tool call, not only the last segment.
  Lookup narration ("Let me check…") and sentences the final answer repeats are left out.
- Prompt: totals always come from `quote_products` / `quote_service`; at most one ZIP question;
  frustrated customers are escalated immediately; damage is answered from the damage policy.
- `npm run db:reset` also clears the mock outbox, and changes nothing if the database is locked.
- e2e runs always use the demo owner login and secrets, whatever `.env` contains.

- `confirmCheckout` takes the payment provider as an injectable dependency and calls it inside
  its transaction. A failed payment rolls back the stock or slot claim, the order or booking
  and the draft update. With the default provider the result is unchanged:
  `Payment{provider:"none", status:"not_required"}`.

## [0.1.0] - 2026-10-05

First public release of the Oasis demo.

### Added

- **Business picker and chat:** five fictional businesses (two product suppliers, three
  on-site services), each with its own AI sales, customer-service and scheduling assistant
  built on the Anthropic API (default model `claude-haiku-4-5`).
- **Grounded answers:** products, services, prices and policies come only from tool results.
  The assistant answers mid-flow questions and then resumes, declines off-topic requests, and
  resists prompt injection.
- **Products:** live inventory checks with partial and out-of-stock handling plus
  alternatives, and US shipping quotes by weight and zone.
- **Services:** quotes with tiers, add-ons and surcharges; availability lookup with the next
  open slot; service-area checks by ZIP.
- **Inline checkout:** a form inside the chat (PII is never typed into chat), server-side
  re-validation, a review step, and an atomic stock/slot re-check at confirm that is safe
  against double submits. Includes a payment-ready `Payment` record (no charge in v1).
- **Status lookup** by reference plus email.
- **Escalation** to the support email with a conversation summary.
- **Notifications:** customer confirmation email (Resend), and business email and SMS
  (Twilio). Without keys, both go to a mock outbox in `.data/outbox/`.
- **Transparency panel** showing each tool call, its masked inputs and outputs, and why it
  ran.
- **Owner dashboard:** scrypt password login and a signed session cookie. Views for orders,
  bookings, inventory, availability, the notification log, conversations and unbooked leads.
- **Guardrails:** per-IP and per-conversation rate limits, per-session and daily USD budget
  caps, LLM timeout and retry with a graceful fallback to the booking form, CSRF checks, a
  nonce-based CSP and security headers, AES-256-GCM encryption of PII at rest, card/SSN
  redaction, and structured JSON logs with request IDs.
- **Accessible, responsive UI** for 375, 768 and 1440 px, targeting WCAG AA.
- **Data layer:** Prisma 7 with SQLite (better-sqlite3 driver adapter), a Postgres-ready
  schema, and an idempotent demo seed (`npm run seed`, `npm run db:reset`).
- **Tests:** Vitest unit and integration tests with V8 coverage, Playwright e2e and screenshot
  specs that use a scripted, TEST-ONLY assistant (no API key needed), and an agent eval runner
  (`npm run eval`).
- **Tooling and deployment:** a `Makefile` that mirrors the npm scripts, a multi-stage
  `Dockerfile` (Debian slim, non-root, health check, migrate and seed on boot),
  `docker-compose.yml`, a `render.yaml` Blueprint for Render Free, and GitHub Actions CI
  (lint, typecheck, coverage, build, e2e, coverage badge).
- `LICENSE` (MIT), `CONTRIBUTING.md` and `SECURITY.md`.

[Unreleased]: https://github.com/U1186204/AI-Agent-Sales-Calls/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/U1186204/AI-Agent-Sales-Calls/releases/tag/v0.1.0
