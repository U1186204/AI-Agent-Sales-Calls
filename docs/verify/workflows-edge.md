# Verify: end-to-end workflows, edge cases, failure conditions

Verifier: workflows/edge agent · Date: 2026-10-06 · Build: `.next` BUILD_ID `J51AWFU-vDGfJG4Qxbt4E` (current; no source newer than the build)

## Setup

- Isolated production server (`next start -p 3204`), with `DATABASE_URL=file:./.data/verify-wf/oasis.db`, `OUTBOX_DIR=.data/verify-wf/outbox`, `APP_URL=http://localhost:3204` and `OASIS_LLM_STUB=1`. Rate limits were lifted the same way as in `tests/e2e/support/e2e-env.ts`. A throwaway owner password hash and session secret were passed as env vars.
- The DB was migrated and seeded the same way as `tests/e2e/global-setup.ts`, then reseeded on 2026-10-06 so the date fixtures were current: mountpro fully booked 10-13, last slot only 10-15; lawn fully booked 10-16; cleaning fully booked 10-20, fragmented 10-22.
- The throwaway scripts are in `.data/verify-wf/` (none are in `tests/`):
  - `ui-flows.mjs`, `ui-edge.mjs`, `owner.mjs`, `crawl.mjs` drive Playwright in a real browser.
  - `money.mjs`, `avail.mjs`, `api-flows.mjs` test the API, with drafts created through `mkdraft.ts`.
  - `outbox-check.mjs` checks notification content.
  - `esc.ts` exercises the escalation tool path.
  - Screenshots are in `.data/verify-wf/shots/`.
- Drafts with explicit selections (add-ons, surcharges, heavy items, threshold carts) were created by calling `createCheckoutDraft` directly. The stub LLM always picks the first in-stock SKU, or the first service and tier, so it cannot make these selections. Review, confirm, status and notification calls then went through the real HTTP API.

## Defect summary

| ID | Sev | Title |
|---|---|---|
| WF-1 | HIGH | "Email support" cannot escalate: it sends a chat message to the same LLM path that just failed, so no Escalation is created |
| WF-2 | MEDIUM | Escalation is a dead end for support: no contact info is captured, and the dashboard has no escalation or transcript view, yet the email says "follow up from the conversation in the owner dashboard" |
| WF-3 | MEDIUM | After a reload, the confirmed checkout card shows the wrong total (draft total without shipping, e.g. $1.40 instead of $10.35) |
| EDGE-1 | MEDIUM | Puerto Rico and other territory ZIPs are priced and promised, but the checkout form rejects their state, so these orders cannot be placed honestly |
| EDGE-2 | MEDIUM | Jobs longer than one business day are quoted and drafted but can never be booked; the customer gets a misleading "no openings" message and an empty calendar |
| WF-4 | LOW | Status page booking summary shows the raw service code (`tv-mounting — Small…, 45 min`) |
| WF-5 | LOW | Business email body and business SMS never name the business ("Oasis: New order…") |
| WF-6 | LOW | Chat "Try again" duplicates the user's message bubble |
| WF-7 | LOW | Owner Bookings tab mixes business-local times without a timezone label, sorted by UTC, so rows look out of order |
| EDGE-3 | LOW | A closed day (Sunday) is reported as "no opening long enough for a N-minute job" instead of "closed" |
| EDGE-4 | LOW | No booking lead time: a slot starting about 25 minutes from now can be booked |
| EDGE-5 | LOW | `OWNER_PASSWORD_HASH` set raw in the process env is `$`-expanded when `.env` also defines it; the server then fails to prepare but keeps listening |
| EDGE-6 | INFO | Refreshing mid-form clears the typed contact and address fields (chat and form are restored) |
| EDGE-7 | INFO | Stub (test-mode) gaps: most starter chips get a generic policy reply; "I need ten breakers" does not start checkout |
| EDGE-8 | INFO | Pricing notes: `new-outlet` is untaxed, while pricing.md lists "outlet parts" as taxable materials; no catalog price can produce a $248.99 subtotal |

Totals: 1 HIGH, 4 MEDIUM, 7 LOW, 3 INFO.

---

## Defects

### WF-1 (HIGH): "Email support" never escalates when it is offered
- **Repro:** Open `/chat/mountpro-tv` and make one `/api/chat` call return 500 (the script injected it with `page.route`; a down LLM, `llm_unavailable` or `llm_unconfigured` gives the same card). The error card shows **Email support**. Click it.
- **Expected:** an `Escalation` row, a support email in the outbox, and the customer told the response time (AT-51, AT-82 "escalation offered").
- **Actual:** the button only posts the fixed `HUMAN_REQUEST_MESSAGE` as a new chat turn. It counts on the model choosing `escalate_to_support`. When the model is unavailable or over budget (exactly when the card appears), the turn returns the same fallback. Measured: escalations +0 after the click. Under the stub, the reply was a generic policy line.
- **Suspected code:**
  - `src/components/chat/ChatApp.tsx` (`askForHuman`, about line 247) and `src/ui-lib/starters.ts` (`HUMAN_REQUEST_MESSAGE`).
  - `src/agent/runner.ts` fallback paths (about lines 400–410, 505–550) set `offerEscalation: true` but have no deterministic escalation.
- **Fix:** add a deterministic escalation endpoint or chat event (for example `event: {type:"escalate"}`) that calls `recordEscalation` and `sendEscalationEmail` server-side without the LLM. The button should use it. Have the stub handle "talk to a person" so e2e can cover it.
- The backend path itself works. Calling `executeTool("escalate_to_support")` directly created `ESC-AGFA-5DDA` and set conversation `escalated=true, outcome=escalated`. The support email went to `support@mountpro-tv.example.com`, the card number was redacted, and the HTML was escaped.
- **Resolution (Fixer A, server):** Server part fixed: `ChatEvent` gains `{type:"request_human", note?, contactEmail?}` (`src/contracts/chat.ts`); `src/agent/runner.ts` `requestHuman` records the escalation + support email WITHOUT the LLM (also past the message cap, `src/app/api/chat/route.ts`), sets outcome escalated, replies with ticket, support email and response time, trace "Escalated to a person"; idempotent for 10 min (`src/domain/escalation.ts`). The UI button sends this event (UI fixer). Verified live: `ESC-BLVS-PFZM … support@mountpro-tv.example.com … within 4 business hours`. Tests: `tests/unit/agent/hardening.test.ts` › "request_human event (WF-1)"; `tests/unit/agent/route.test.ts` › "WF-1: request_human works without an LLM key and even after the message cap"; eval `request-human-event`.
- **Resolution (Fixer B, UI):** "Email support" is now "Talk to a person" everywhere: always in the composer area, plus on the newest error/fallback card and on replies with `offerEscalation`. It opens a small inline form (optional email, validated with the shared `Email` schema, Escape/Cancel return focus) and sends `{type:"request_human", contactEmail?}` — no message to the model. e2e: `ui-chat.spec.ts` › "Talk to a person …" (mocked) and `fullstack-escalation.spec.ts` (real server, stub mode: ticket ref in the reply, owner API + Escalations view + transcript).

### WF-2 (MEDIUM): support cannot follow up on an escalation
- **Repro:** Trigger `escalate_to_support`. Read the support email in the outbox. Open `/owner`.
- **Expected:** support can reach the customer: contact info captured, or a transcript or escalation view in the dashboard.
- **Actual:**
  - The email says "The customer did not share contact details in chat. Follow up from the conversation in the owner dashboard."
  - The dashboard shows only an escalation count (Overview, "Needs attention") and "Conversations — Metadata only. Transcripts stay encrypted."
  - It has no escalation list and no transcript view (SPEC §2 P1 "Unbooked-lead list, transcript view").
  - The `escalate_to_support` tool input has no contact field, so `contactEmail` is never set.
- **Suspected code:** `src/components/owner/OwnerDashboard.tsx:442`, `src/domain/owner.ts` (no escalation listing), `src/contracts/tools.ts` (EscalateToSupport input), `src/notify/templates.ts` (escalation copy).
- **Fix:** add an Escalations tab with a masked transcript. Optionally show a small secure contact form (like checkout) when escalating. At minimum, change the email copy so it does not point to a view that does not exist.
- **Resolution (Fixer A, server):** Server part fixed: `GET /api/owner/escalations` and `GET /api/owner/conversations/:id/transcript` (`src/app/api/owner/escalations/route.ts`, `src/app/api/owner/conversations/[id]/transcript/route.ts`, `src/domain/owner.ts` `listEscalations`/`getConversationTranscript`, contracts in `src/contracts/owner.ts`); contact email can be captured via `request_human.contactEmail`; escalation email copy now points to Escalations in the dashboard. Tests: `tests/unit/integration/api-routes.test.ts` › "escalations list and transcript need a session and return masked data"; `tests/unit/agent/hardening.test.ts` › "WF-2: …".
- **Resolution (Fixer B, UI):** UI part: new Escalations view (ticket, business, opened with zone, reason, summary, masked contact or "Not shared", status, Transcript button) and an accessible transcript drawer (native modal `<dialog>`, labelled, Escape/backdrop/close button, focus returns to the row button) opened from Escalations and Conversations. e2e: `ui-status-owner.spec.ts` › "owner escalations + transcripts", `fullstack-escalation.spec.ts`.

### WF-3 (MEDIUM): wrong total on the confirmed card after a reload
- **Repro:** On `/chat/volt-supply`, send "buy 2" and complete checkout (ZIP 46204). The card says "Total $10.35". Reload the page.
- **Expected:** still $10.35.
- **Actual:** "Total $1.40". This reproduced 3/3 viewports for volt ($10.35 → $1.40) and flowline ($19.16 → $10.21). Services show the right total because they have no shipping.
- **Suspected code:** `src/components/checkout/CheckoutForm.tsx:227`: `setDone({ reference: d.resultRef, totalCents: d.quote.totalCents, ... })`. `d.quote` is the draft quote saved by `start_checkout`, before any ZIP, so it has no shipping. Confirm prices with the customer's ZIP but never writes the result back to the draft.
- **Fix:** on confirm, save the final quote or total on the draft (or add `resultTotalCents`), and return that from `GET /api/checkout/draft/:id` for completed drafts.
- **Resolution (Fixer A, server):** Server part fixed in `src/domain/checkout.ts`: confirm stores the FINAL quote (with shipping to the entered ZIP) on the draft, so `GET /api/checkout/draft/:id` of a completed draft returns the confirmed total. Test: `tests/unit/integration/api-routes.test.ts` › "SEC-3: a draft is bound to its conversation…" (asserts the completed view total equals the confirm total).
- **Resolution (Fixer B, UI):** UI part: on confirm the tab stores `{reference,totalCents}` from the CheckoutResult; a reload of a completed draft shows that total (falling back to the draft's now-final quote). e2e: `fullstack-checkout.spec.ts` reloads after confirm and asserts the same shipping-inclusive "Total $…" and a single event pill.

### EDGE-1 (MEDIUM): territory ZIPs cannot be ordered to
- **Repro:** Review a volt draft with `customer.zip="00901"`, `state="PR"` → **422 `{"state":["Choose a US state"]}`**. With `state="IN"` and ZIP 00901 it is accepted and priced at zone 8 ($14.30 shipping for 1 GFCI).
- **Expected:** SPEC §6 says "any valid US ZIP ships here" and covers AK/HI/PR/territories at zone 8. The shipping policy text promises "including Alaska, Hawaii and US territories".
- **Actual:** `US_STATES` is the 50 states plus DC only, so PR, GU, VI and other territory customers must enter a false state. The form also never checks that the state matches the ZIP (CA with 46241 ships at zone 2).
- **Suspected code:** `src/contracts/customer.ts:4–58` (`US_STATES`), and SPEC §5 `state ∈ 50 states + DC`.
- **Fix:** add PR, VI, GU, AS and MP, plus military AA/AE/AP if wanted. Optionally cross-check the ZIP prefix against the state. Then align SPEC §5 with §6.
- **Resolution (Fixer A, server):** Fixed with ADV-1 (territories accepted; ZIP↔state check rejects clear mismatches such as CA + 46241 with an error on `zip`). Tests: `tests/unit/contracts.test.ts` › zip/state blocks; eval `territory-order-pr`.
- **Resolution (Fixer B, UI):** UI part: the state select groups "U.S. territories" (and military codes if the contract ever lists them) in an optgroup; the ZIP mask accepts 9 digits without a dash ("009011234" → "00901-1234"). e2e: `ui-checkout.spec.ts` › "checkout persistence" orders to PR 00901-1234.

### EDGE-2 (MEDIUM): multi-day jobs are quoted but cannot be booked
- **Repro 1:** Draft `move-clean` 5BR with `interior-windows`×6 and `inside-cabinets`: 645 min, $885.00. BrightNest's day is 08:00–18:00, which is 10 one-hour slots (600 min).
- **Repro 2:** Lawn XL with 9 extra acres, severe overgrowth and weeding×4 (645 min) also exceeds the 9-slot day.
- **Expected:** the quote or draft should flag that the job does not fit one visit, and offer to split it or escalate.
- **Actual:**
  - The draft is created.
  - `GET /api/checkout/draft/:id` returns `availability.dates: []`.
  - The form shows a calendar with no selectable day and "Pick a day to see times", with no explanation.
  - `check_availability` says "No openings between 2026-10-06 and 2026-12-04", which wrongly suggests the calendar is full.
  - The 600-minute variant (exactly a full day) books correctly.
- **Suspected code:** `src/domain/checkout-draft.ts` (createCheckoutDraft, service branch, no feasibility check), `src/domain/availability.ts` (`checkAvailability` message), `src/components/checkout/CheckoutForm.tsx` (no empty-availability state).
- **Fix:** compare `slotsNeeded(duration)` with the longest bookable run per business day. If it is longer, return a specific error or message ("This job is longer than one visit. Please contact us to schedule a multi-day job") and show it in the form.
- **Resolution (Fixer A, server):** Fixed in `src/domain/hours.ts` (new: `maxBookableMinutes`, `requiresOnSiteEstimate`), `src/domain/catalog.ts` (`quote_service` returns `requiresOnSiteEstimate` + `onSiteEstimateReason`), `src/domain/availability.ts` (`check_availability` returns it instead of an empty calendar), `src/domain/checkout-draft.ts` (`start_checkout` → `requires_on_site_estimate`), `src/agent/prompt.ts` rule 10 + tool descriptions (explain, offer escalation). Test: `tests/unit/agent/hardening.test.ts` › "EDGE-2: a job longer than a business day needs an on-site estimate everywhere" (645 min refused, 600 min still bookable); eval `onsite-estimate-long-job`.

### WF-4 (LOW): raw service code on the status page
- **Repro:** `/status` lookup of any booking, for example `OAS-KPCY-FZEZ`.
- **Expected:** "TV wall mounting — Small (up to 42")…"
- **Actual:** "tv-mounting — Small (up to 42"), 45 min". The same raw code appears for `lawn-mowing` and `standard-clean`.
- **Code:** `src/domain/status.ts:92` uses `bk.serviceCode`.
- **Fix:** use `getServiceDefinition(businessId, code)?.name`, and format minutes with `formatDuration`.
- **Resolution (Fixer A, server):** Server part fixed with VIS-3 in `src/domain/status.ts` (`serviceName`, `itemsLabel`, summary uses the service name and `formatDuration`). Test: `tests/unit/agent/hardening.test.ts` › "VIS-3/WF-4: …".
- **Resolution (Fixer B, UI):** UI part covered by VIS-3 (status shows `serviceName`).

### WF-5 (LOW): business notifications do not name the business
- **Repro:** Check any `*-email-business-*.json` and `*-sms-business-*.json` in the outbox.
- **Actual:**
  - The subject is "New order OAS-… — Ana O. — $10.35".
  - The body starts "New order received via Oasis" and never names the business.
  - The SMS is "Oasis: New order OAS-… — Ana O., 2 items, $10.35. Details in email."
  - Reference, totals, appointment time (business-timezone abbreviation, e.g. "1:00 PM MDT") and the no-address rule are all correct.
- **Fix:** add `businessName` (or `shortName`) to the business email subject and body and to the SMS prefix, in `src/notify/templates.ts`.
- **Resolution (Fixer A, server):** Fixed in `src/notify/templates.ts`: business email subject/title name the business ("New order OAS-… for Volt & Wire Electrical Supply — $10.35"), SMS prefix is the business short name ("Volt & Wire: New order …"). Test: `tests/unit/notify/notify.test.ts` › "WF-5 + SEC-12: …", "booking SMS includes time and duration, no address".

### WF-6 (LOW): "Try again" duplicates the user bubble
- **Repro:** Go offline (`context.setOffline(true)`), send "what's your return policy?", go back online, click **Try again**.
- **Actual:** the question appears twice in the transcript, and the old error card stays above the answer.
- **Code:** `src/components/chat/ChatApp.tsx` `send()` always appends a user item. The retry button calls `send({message: item.retryText})`.
- **Fix:** on retry, remove or replace the error item and skip re-adding the user bubble.
- **Resolution (Fixer B, UI):** "Try again" removes the failed card and re-sends the stored payload without adding a user bubble (also for events). e2e asserts one user bubble and one card after a retry.

### WF-7 (LOW): Bookings tab timezones
- **Repro:** `/owner` → Bookings, with lawn and mountpro bookings on the same day.
- **Actual:**
  - The rows read, in order: "GreenStripe … Oct 6, 1:00 PM", then "MountPro … Oct 6, 12:00 PM", then "MountPro … 1:00 PM".
  - Each time is business-local with no zone label, while rows are sorted by UTC.
  - 1 PM CDT and 12 PM MDT are the same instant, so the list looks unsorted and is ambiguous.
- **Fix:** add the zone abbreviation (the data is there; `appointmentLabel` already includes it) or a timezone column.
- **Resolution (Fixer A, server):** Server part fixed in `src/domain/owner.ts` (`listBookings` sorts by business-local wall-clock start, then UTC; `timezoneLabel`) and `src/app/api/owner/bookings/route.ts` (rows add `timezoneLabel` e.g. "MDT" and `localStart` e.g. "Tue, Oct 6, 2026, 1:00 PM MDT"). Tests: `tests/unit/integration/api-routes.test.ts` › "bookings carry a timezone label + local start…"; `tests/unit/agent/hardening.test.ts` › "WF-7: …".
- **Resolution (Fixer B, UI):** UI part: the Bookings table shows the server's `localStart` with zone ("Thu, Oct 8, 2026, 10:00 AM MDT"); e2e asserts the zone label.

### EDGE-3 (LOW): closed-day message
- `checkAvailability(date="2026-11-01")` (a Sunday) returns `fullyBooked:true` with "2026-11-01 has no opening long enough for a 45-minute job", where it should say the business is closed on Sundays. The next openings it offers (Mon 11-02) are correct.
- **Code:** `src/domain/availability.ts` (the `q.date` branch).
- **Fix:** check `bookingHours` for that weekday first.
- **Resolution (Fixer A, server):** Fixed in `src/domain/availability.ts` + `src/domain/hours.ts`: a requested closed weekday returns `closed: true`, `fullyBooked: false`, "MountPro is closed on Sundays…" and the next openings. Test: `tests/unit/agent/hardening.test.ts` › "EDGE-3: a closed day is reported as closed…".

### EDGE-4 (LOW): no lead time
- At 11:34 MDT, today's 12:00 PM MountPro slot was offered and booked (`OAS-HPXN-J29D`). Brightnest offered a slot about 85 minutes out.
- **Code:** `openStarts` filters only `startsAt > now`.
- **Fix:** add a `MIN_LEAD_MINUTES` constant (for example 120) in `src/config/constants.ts` and apply it in `openStarts` and `findRunForAnchor`.
- **Resolution (Fixer A, server):** Fixed: `minLeadMinutes` per business in `src/config/businesses.ts` (120 for service businesses); `openStarts` never offers sooner starts and `findRunForAnchor` refuses them at confirm (30-min grace for an already-open form). Test: `tests/unit/agent/hardening.test.ts` › "EDGE-4: nothing starts sooner than the 2-hour lead time".

### EDGE-5 (LOW): `$` expansion of the owner hash from the process env
- **Repro:** Export `OWNER_PASSWORD_HASH='scrypt$16384$8$1$…'` (the raw form that `npm run owner:hash` labels "for host dashboards / docker env") while `.env` also defines `OWNER_PASSWORD_HASH`. Then `next start`.
- **Actual:**
  - `Failed to prepare server … OWNER_PASSWORD_HASH: must be scrypt$N$r$p$salt$hash`.
  - The process stays bound to the port (it kept LISTENING), so it is up but cannot serve requests.
  - Exporting the escaped `\$` form works.
- **Fix:** document the escaped form for this case too, and/or exit the process when instrumentation `register()` throws.
- **Resolution (Fixer A, server):** Fixed in `src/config/env.ts` (a value starting with `scrypt` that fails the format gets an explanation of `$` expansion and how to fix it) and `src/instrumentation-node.ts` (invalid env → logged error + `process.exit(1)`, so the server no longer stays bound to the port half-started); `.env.example` documents not defining it in both places. Test: `tests/unit/guard/injection.test.ts` › "explains a $-expanded OWNER_PASSWORD_HASH…".

### EDGE-6 (INFO): refresh mid-form
Reloading in the middle of the form restores the chat (sessionStorage) and the form (draft re-fetched) but clears the typed fields. Not keeping PII in storage is defensible, but a short hint ("for your privacy, details aren't saved on reload") would help.
- **Resolution (Fixer B, UI):** In-progress fields, date and time are kept in sessionStorage for this tab only (`oasis:checkout:<draftId>`, wrapped in try/catch), restored on reload, replaced by just `{reference,totalCents}` on success, and cleared on Start over. e2e: `ui-checkout.spec.ts` › "typed details survive a reload … forgotten after confirm".

### EDGE-7 (INFO): stub coverage
In stub mode, 19 of 20 starter chips get the generic "I can help with … Policies I can explain …" reply. Only "What's your next available appointment?" opens a form. "I need ten 20-amp single-pole breakers" does not start checkout (no buy/order keyword). The stub cannot escalate, which blocks e2e coverage of WF-1. This is test-only, but it means the chips are not exercised end to end.
- **Resolution (Fixer B, UI):** Starter chips reworded so each business has a chip that reaches a form with both the real model and the stub ("I'd like to order …", "Can I book …", "What's your next available appointment?"); the other chips get a grounded answer that tells the customer how to start a checkout, and "Talk to a person" is a dedicated control instead of a chat message. No chip is a dead end.

### EDGE-8 (INFO): pricing notes
- pricing.md §6 says materials such as "outlet parts" are taxed. `new-outlet` ($199, licensed electrician) is `taxable:false`. This is defensible as labor, but should be stated.
- Every catalog price is a multiple of 5¢, so a subtotal of $248.99 cannot occur. The boundary was tested at $248.95 (shipping charged) against $249.00 (free).
- The seeded slot horizon is fixed at seed time. If the DB is not reseeded, the bookable window shrinks day by day. This is expected for a demo; it is noted in the Setup.
- **Resolution (Fixer A, server):** Documented (Info): pricing.md gives `new-outlet` as $199 licensed-electrician labor with no parts amount; its "outlet parts" tax row refers to parts sold separately, so there is nothing to split. Comment in `src/config/pricing.ts`, note in SPEC §6. The $248.99 boundary is unreachable with 5¢ catalog prices (already covered at $248.95/$249.00).

---

## What passed

### 1. Workflows for every business, in a real browser at 375, 768 and 1440 (15 runs, 0 failures)
- **Product (volt, flowline):** chat → inline form. An empty submit gave 8 inline errors. Invalid email, phone and ZIP each got its own message. Then review → edit (values kept) → review → confirm. A double-click on confirm sent exactly 1 request. The success card appeared, the assistant confirmed with the reference, there was no horizontal scroll and no console errors.
- **Service (mountpro, lawn, cleaning):** the same flow, picking a non-default time. The review showed the right date and time in the business timezone (Mountain, Central, Pacific) and the contractor.
- **API flows with explicit selections**, re-priced to the cent:
  - Heavy order: 2 toilets + PEX to FL. $855.28, toilet stock 6→4, PEX 65→64.
  - Free-shipping threshold order: $249.00 subtotal → $267.68, shipping $0.
  - TV L + full-motion + in-wall + fireplace + masonry: $657.85, 180 min.
  - Lawn XL + 2 acres, overgrown, steep, weekly, edging: $394.50, 210 min.
  - Clean 3BR + 2 baths + pet + 200 sq ft, biweekly: $243.00, 205 min.
  - Each multi-hour booking took `ceil(min/60)` consecutive slots of one contractor (gaps 60,60,…; 1 contractor). Only the anchor slot has `bookingId`.
- **Status lookup:** found every order and booking (reference and email both case-insensitive). A wrong email gave the generic not-found message.
- **Owner dashboard** (375 and 1440): a bad password showed an error, the good one signed in. All 7 tabs rendered with the new data:
  - Orders, with zone and total.
  - Bookings, with technician.
  - Inventory, with decrements (EL-USB-15 now "Out of stock").
  - Availability, showing booked and closed Sundays.
  - Notifications, 3 per checkout, recipients masked.
  - Conversations, with outcome.
- **Notifications:** customer email, business email and business SMS for every fresh confirm, and none on replay. Content checks:
  - Correct reference and totals in all three.
  - Customer email names the business.
  - Appointment shown in business-local time with the zone abbreviation (e.g. "Tue, Oct 6, 2026, 12:00 PM PDT").
  - No customer address in any SMS.
  - HTML escaped (`<script>` in address1 and `<bell>` in the instructions do not appear unescaped in any `html`).

### 2. Money: 36 checks, all exact to the cent (except the EDGE-2 unbookable case, which could not be priced at review)
- **Shipping zones:**
  - ME 04101 → zone 5
  - FL 33101 → 5
  - TX 75201 → 5
  - CA 90001 → 8
  - WA 98101 → 8
  - AK 99501 → 8
  - HI 96813 → 8
  - PR 00901 → 8
  - Guam 96910 → 8
  - NY → 4, OH → 3, GA → 4, MN → 5
  - ZIP+4 46241-1234 → zone 2
- **Heavy handling:** $25 per unit over 50 lb. The 32 lb panel is not heavy. Free shipping still charges heavy units base + per-lb × heavy weight.
- **Free-shipping boundary:** $248.95 (charged) against $249.00 (free).
- **Rounding:** tax half-up (7 × $3.80 → tax $1.995 → $2.00), computed once per order.
- **Tax base:** tax only on goods and materials; labor, surcharges and shipping untaxed. pricing.md's $637 TV example + materials tax = $657.85.
- **Discounts:** frequency discounts apply to the base only, before tax. Percent surcharges apply to the base including extra acres.
- **Clean add-ons:** included baseboards on deep and move cleans priced $0; half baths at half price; per-sq-ft surcharge.
- **Invalid selections rejected at draft:** two mounts, weekly on deep, overgrown + severe, extra units on a non-XL tier, shelves × 3.
- **Data:** all 50 seed products match pricing.md (name, price, weight, stock).

### 3. Availability and time
- **DST (Nov 1 2026, a Sunday, closed):** Sat Oct 31 and Mon Nov 2 each have 9 slots per business, with identical local labels (9:00 AM–5:00 PM Denver, 8:00 AM–4:00 PM Chicago, 8:00–4:00 Los Angeles for 90-minute jobs). UTC shifts by 1 h (15:00Z → 16:00Z in Denver), so nothing is duplicated or missing.
- **Horizon:** offered through day 60 (2026-12-04 = today + 59). 12-05 → "We book up to 60 days ahead (through 2026-12-04)", plus the nearest slots.
- Today's past starts are excluded. No Sundays are offered.
- **Seeded fixtures:**
  - Fully booked dates (10-13, 10-16, 10-20) are never offered; `check_availability` returns `fullyBooked:true` and the next day's openings.
  - Last-slot-only 10-15 offers only 5:00 PM.
  - Fragmented 10-22 offers nothing for a 90-minute job.
- Multi-hour jobs need consecutive slots of one contractor; the latest start fits the close time.

### 4. Concurrency and failure
- **Slot taken between review and confirm (browser plus 3 other customers):** the form returns to the Details step with "That time was just booked by someone else. Please pick another time." The taken time is removed and no time is selected. Re-picking and confirming succeeded.
- **3 parallel confirms, same start, 2 contractors:** 2 succeed (2nd contractor auto-assigned), 1 gets 409 `slot_unavailable`.
- **Last unit (EL-USB-15 at 1), 3 parallel confirms:** 1 succeeds, 2 get 409 `out_of_stock`, stock ends at 0 (never negative).
- **Same draft confirmed 3× in parallel:** the same reference each time, `replayed` true on 2, orders +1, notifications +3 (not 9).
- **Expired draft:** review and confirm return 410 `draft_expired`. The UI shows "This checkout expired. Ask the assistant to start again…", also after a reload. Asking again creates a fresh form.
- **Offline during confirm:** a "We couldn't reach the server…" banner, the confirm button stays enabled, and it succeeds once back online. Offline chat shows an error card with Try again.
- **Server 500 on confirm** (injected, non-JSON HTML body): a friendly banner, still on Review, and the retry succeeded. Chat 500 → error card with Try again, Email support and a mailto fallback.
- **Refresh after success:** the card shows confirmed (but see WF-3), with no duplicate confirm and no duplicate system event (1 event pill).
- **Back button:** the chat and the open form are restored.
- **sessionStorage blocked (getter throws):** the full checkout works with no page errors. History is simply not kept.

### 5. Chat UX
- **Start over:** clears messages and the trace panel and resets storage to empty. The next message creates a new conversation (20 chip turns → 20 unique conversation ids).
- **Trace panel:** shows each step (Searched the catalog → Prepared secure checkout) with why, masked input, result summary, data refs and timings.
- **Input limits:** 2,000 characters accepted; 2,001 disables Send and the counter shows "too long".
- **Long messages:** a 1,500-character unbroken word wraps inside the bubble with no page scroll. A very long assistant reply could not be produced by the stub, so long-reply rendering was not tested.
- **XSS:** a payload in chat renders as text; no `javascript:` links.

### 6. Links, buttons and copy
- **Pages:** `/`, the 5 chat pages, `/status` and `/owner/login` all return 200, with titles and an h1. Unknown pages and unknown businesses return a 404 page.
- **Links:** all 11 distinct links resolve (200).
- **Buttons:** every button tried had a visible effect. These were the Trace sheet, Look up, the tabs, Edit details, Confirm, Try again and Email support. Email support has the escalation problem in WF-1.
- **Copy:** no lorem, TODO, "coming soon" or placeholder copy in `src`. The only input placeholders are the composer hint and the "(555) 555-0123" phone example.
