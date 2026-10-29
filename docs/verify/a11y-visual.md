# Verify: accessibility + visual regression + design critique

Date: 2026-10-06. This is a report only: nothing under `src/`, `tests/`, `prisma/`, `evals/` or config was changed.

## Setup

- **Main server.** Isolated production server (existing `.next` build `J51AWFU-vDGfJG4Qxbt4E`, no rebuild) on **:3203**.
  - Settings: `DATABASE_URL=file:./.data/verify-a11y/oasis.db`, `OUTBOX_DIR=.data/verify-a11y/outbox`, `APP_URL=http://localhost:3203`, `OASIS_LLM_STUB=1`, rate limits lifted.
  - The DB was migrated and seeded like `tests/e2e/global-setup.ts`, and reseeded after the date rolled over.
- **Error-state server.** A second short-lived server on **:3213** ran against a copy of that DB.
  - Settings: no stub, invalid `ANTHROPIC_API_KEY`, `OASIS_FAULT=llm_error`, `RATE_LIMIT_IP_PER_10MIN=3`.
  - It was used to produce the real `llm_unavailable` and `429 rate_limited` states.
- **Both servers are stopped.** The :3203 server was also killed once by the host for low memory and was restarted.
- **Tools.** Throwaway Playwright scripts are in `.data/verify-a11y/`: `states.mjs`, `keyboard.mjs`, `probe.mjs`, `errors.mjs` and `audit-lib.mjs`. They use `@axe-core/playwright` with the tags `wcag2a, wcag2aa, wcag21aa, best-practice`. Raw JSON is in `.data/verify-a11y/results/`.
- **Coverage.** 3 widths (375×812 touch, 768×1024, 1440×900) × 33 states, plus 6 error-state captures. Every state got a screenshot, an axe run, and an in-page audit:
  - computed-style contrast for every rendered text node, placeholders and disabled text
  - non-text contrast of control borders
  - `scrollWidth` vs `clientWidth`, truncation and inner horizontal scrollers
  - tap targets
  - headings, landmarks, live regions, labels, button names and images
  - the set of rendered colours
- **States covered.**
  - Home and 404 (both a bad path and an unknown business).
  - Chat: empty, composer filled, stub reply with trace, trace highlight (desktop), and the trace sheet before and after checkout (phone/tablet).
  - Product checkout: form empty, form errors, form filled with the summary open, review, success with the chat event.
  - Booking: calendar, calendar with times, errors, review, success.
  - Status: empty, errors, not found, found (order), found (booking).
  - Owner: login, login with validation errors, login with a bad password, and all 7 owner tabs with real orders and bookings.
- **Screenshots.** All 156 PNGs I created in `.artifacts/screenshots/` were reviewed, then deleted. Three files I did not create (`desktop-1440-home.png`, `phone-375-home.png`, `tablet-768-home.png`, presumably another agent's) were left alone.

## Summary counts

| Severity | A11Y | VIS | Total |
|---|---|---|---|
| High | 1 | 3 | 4 |
| Medium | 5 | 4 | 9 |
| Low | 8 | 9 | 17 |
| **Total** | 14 | 16 | **30** |

There are no Critical or blocker defects. The only axe violation anywhere is `heading-order` (moderate), on every chat state that contains a checkout form (A11Y-6). Every other state is axe-clean at all three widths, including the error states.

---

## Accessibility defects

### A11Y-1: Focus is lost to `<body>` on every checkout step change. **High**
- **Where:** Product and booking checkout, all widths.
- **Repro:**
  1. In `/chat/volt-supply`, send "I'd like to buy 1 please".
  2. Fill the form and press Enter on "Review order".
  3. Read `document.activeElement`.
- **Expected:** Focus moves to the new step: the review heading or region, or "Confirm order".
- **Actual:** `document.activeElement === body` after Review (form → review), after "Edit details" (review → form), and after "Confirm order" (→ success). The button the user activated unmounts and nothing receives focus.
- **Impact:**
  - Keyboard users restart from the top of the document. On the chat page that means the header.
  - Screen-reader users get no cue for review → form, which has no live region. The review → success transition is announced only through `role=status`.
- **Suspected:** `src/components/checkout/CheckoutForm.tsx:396-399` (`setStep("review"); scrollIntoView()`), `:656-659` (Edit details), `:418-423` (confirm). There is no focus call in any of them.
- **Fix:** Add a `tabIndex={-1}` ref per step and focus it after the step changes:
  - Review: the "Review your order" heading, made visible or kept visually hidden.
  - Form: the first field, or the field being edited.
  - Success: `.success__title`.
  - Use `requestAnimationFrame` after `setStep`.
- **Resolution (Fixer B, UI):** Each step heading has `tabIndex=-1` and takes focus after the step renders: "Review your order/booking" (now a visible h3) on review, the form title (h2) on Edit details, "Order confirmed"/"You're booked" (h3) on success, then the card scrolls into view (`CheckoutForm.tsx` `goTo` + `pendingFocus` effect). e2e: `ui-checkout.spec.ts` asserts `toBeFocused()` on every transition (product and keyboard-only booking).

### A11Y-2: JS smooth scrolling ignores `prefers-reduced-motion`. **Medium**
- **Where:** Chat, 375 and 768 (any width where the list scrolls).
- **Repro:**
  1. Create a context with `reducedMotion: "reduce"`.
  2. Send "I'd like to buy 1 please".
  3. Log `.chat-scroll` scroll events.
- **Expected:** One jump.
- **Actual:** 14 intermediate scroll positions (3, 14, 46, 106, 147, …, 223), so the scroll is animated. The CSS reduce block (`globals.css:184-192`) only covers CSS `scroll-behavior`, and explicit `behavior: "smooth"` overrides it.
- **Suspected:** `ChatApp.tsx:176-177`, `ChatApp.tsx:334`, `CheckoutForm.tsx:316`.
- **Fix:** `const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"`, shared from a `ui-lib` helper.
- **Resolution (Fixer B, UI):** New `src/ui-lib/motion.ts` `scrollBehavior()` returns "auto" under `prefers-reduced-motion`; used by every scripted scroll (`ChatApp` list + trace, `CheckoutForm`). e2e: `ui-chat.spec.ts` › "reduced motion: scripted scrolling jumps" records the requested behaviors (smooth by default, never smooth when reduced).

### A11Y-3: Form-control boundaries fail non-text contrast (WCAG 1.4.11). **Medium**
- **Where:** Every form at all widths: checkout fields, status, login, owner filter, time-slot tiles.
- **Repro:** Read the computed border of an unfocused `.input` against its background.
- **Expected:** ≥ 3:1 for the visual boundary that identifies the control.
- **Actual:**
  - `.input`, `.select`, `.textarea` and `.time label`: `#d2d2d7` on `#fff` = **1.51:1**.
  - Owner `#biz-filter` on `#f5f5f7` = **1.38:1**.
  - Available calendar days are marked only by a `#e6f3f4` fill = **1.14:1**, and the legend swatch is the same.
- **Suspected:** `globals.css:540-553` (`--line-strong` border), `:2035` (`.cal__day[data-available]`), `:2064` (`.cal__swatch`), `:2097-2103` (`.time label`).
- **Fix:**
  - Use a `#8e8e93`-class border for inputs (about 3.3:1), or keep the light border and add a 1px `#86868b` bottom edge.
  - For available days, add a 1px accent ring or weight/underline cue so the fill tint isn't the only signal.
- **Resolution (Fixer B, UI):** Inputs, selects, textareas, time tiles and the composer use `--control-border` #86868b (3.6:1 on white, 3.3:1 on #f5f5f7). Available calendar days are bold + a dot under the number (tint is no longer the only cue); the legend says "Bold days have openings".

### A11Y-4: The focus indicator on text inputs is weak, and on invalid inputs it is nearly invisible. **Medium**
- **Where:** All inputs, all widths. The worst case is a field already in its error state.
- **Repro:** Submit an empty checkout, then Tab between invalid fields. Compare `focus-1440-input-error` with an unfocused invalid field.
- **Expected:** A clearly perceivable change of at least a 2px-thick ring at ≥ 3:1 (1.4.11 / 2.4.7; this is also the 2.4.13 AAA guideline).
- **Actual:**
  - On focus, the border changes to 1px `#0a7c86` and a 3px halo `rgb(10 124 134 / .28)` appears. The halo is about **1.4:1** against white, so the only ≥ 3:1 change is 1px.
  - On invalid fields the border is already red and stays red. The halo `rgb(180 35 24 / .22)` is about 1.3:1, so focused and unfocused invalid fields look almost identical.
- **Suspected:** `globals.css:566-583`.
- **Fix:**
  - Keep the global 3px `--accent` outline (offset 2px) on inputs, or make the box-shadow solid `0 0 0 2px var(--accent)`.
  - For invalid fields, use a solid 2px danger ring plus an outline offset so the focus change still reads.
- **Resolution (Fixer B, UI):** Text fields show a solid 2px accent outline (offset 2px) plus accent border on focus; invalid fields keep a 2px red border and still get the accent ring, so focus change is obvious (`globals.css` forms block).

### A11Y-5: Tap targets under 44px on phone. **Medium**
- **Where:** 375 (also 768 and 1440). Everything listed passes WCAG 2.5.8 (24px) but fails the 44px design target.
- **Repro:** Measure the bounding rects of interactive elements at 375×812.
- **Actual:**

  | Element | Size (px) |
  |---|---|
  | `.composer__send` | 36×36 |
  | `.btn--small` (Trace, Start over, Sign out) | height 36; icon-only Start over is 40×36 |
  | Calendar prev/next `.icon-btn` | 36×36 |
  | `.cal__day` | 42×42 |
  | `.starter` chips | height 40 |
  | Owner `.tab` | height 40 |
  | `#biz-filter` | height 40 |
  | `.chat-header__back` | 60×40 |
  | `.msg__trace-link` ("N lookups: see how it answered", "Email support") | height 24 |
  | `<summary>` (Order summary, Price, Technical details) | height 24-27 |
  | Footer links | height 20 |
  | Brand link | height 24 |

- **Suspected:** `globals.css:1333` (`.composer__send`), `:351` (`.btn--small`), `:362` (`.icon-btn`), `:2016` (`.cal__day`), `:1231` (`.starter`), `:2175` (`.tab`), `:1196` (`.msg__trace-link`).
- **Fix:** Under `@media (pointer: coarse)` set `min-height: 44px` and/or extend the hit area with padding or `::after` (send 44, icon-btn 44, starter/tab 44). For the inline text links, add vertical padding to reach 44 without changing the visuals.
- **Resolution (Fixer B, UI):** Under `(pointer: coarse), (max-width: 767px)` every listed control is at least 44px (send, small buttons, icon buttons, calendar days, starters, tabs, selects, trace links, summaries, footer/brand links, Talk to a person); calendar cells drop border-spacing below 480px. e2e: `expectTapTargets` at 375 in `ui-chat.spec.ts` (chat + booking form) and `ui-status-owner.spec.ts` (owner controls).

### A11Y-14: Focus stays in the composer after sending (suspected soft-keyboard problem on mobile). **Medium**
- **Where:** Phone, after sending a message that returns a checkout form.
- **Repro:** At 375 with touch, send "I'd like to buy 2 please". Focus is still `#chat-input`, which keeps its focus ring in every phone screenshot.
- **Expected:** On a touch device the soft keyboard closes so the new form can be read and filled.
- **Actual:** `submitComposer()` re-focuses the textarea. On real iOS/Android this keeps the keyboard covering roughly half the screen, including the form that just arrived. This could not be confirmed in emulation and is inferred from the code plus the focus state.
- **Suspected:** `ChatApp.tsx:272`.
- **Fix:** Skip the re-focus when `matchMedia("(pointer: coarse)")` matches, or blur when the reply contains a form block.
- **Resolution (Fixer B, UI):** After sending, the composer is blurred on touch devices (`isCoarsePointer`) so the soft keyboard closes; when a reply carries a form, the form heading takes focus instead of the composer (`autoFocus` on the new `CheckoutForm`). e2e: `ui-checkout.spec.ts` asserts the new form's h2 is focused.

### A11Y-6: Heading order skips a level in chat checkout (axe `heading-order`, moderate). **Low**
- **Where:** All checkout states in chat at all widths. That is 10 states × 3 widths, or 30 axe hits.
- **Repro:** axe on `/chat/volt-supply` after a checkout form appears.
- **Expected:** h1 → h2 → h3.
- **Actual:**
  - The page `h1` (business name) is followed by `h3.checkout__title`, with no h2 in the message list.
  - Review uses `h4` blocks under a visually hidden `h4`.
  - Success uses `h4`, and the calendar month is an `h4`.
- **Suspected:** `CheckoutForm.tsx:489` (h3), `:551`, `:583`, `:603-644` (h4), `DatePicker.tsx:166` (h4).
- **Fix:** Make the checkout title an `h2` and shift its children to `h3`, or wrap the conversation in a visually hidden `h2` "Conversation".
- **Resolution (Fixer B, UI):** Checkout title is now h2, review/success/calendar month h3, review blocks h4 (h1 → h2 → h3 → h4). The axe `heading-order` hits are gone in all checkout e2e states.

### A11Y-7: Chat errors are announced twice. **Low**
- **Where:** Chat error states: rate limited, network, and the other `res.ok === false` paths.
- **Repro:** Trigger a 429 (captured live). The MutationObserver log shows a `role=alert` with the full card text, then the polite announcer with "You're sending messages quickly".
- **Expected:** One announcement.
- **Actual:** Two.
- **Suspected:** `ChatApp.tsx:261` (`setAnnounce(errorCopy…)`) together with `:448` (`role="alert"` on the card).
- **Fix:** Drop `setAnnounce` for errors, or remove `role="alert"` and announce the title plus body once.
- **Resolution (Fixer B, UI):** Error cards are no longer `role=alert`; each error is announced once through the polite announcer ("title. body"). e2e asserts no alert role in the message list.

### A11Y-8: Date-picker grid semantics are mixed. **Low**
- **Where:** Booking form calendar.
- **Repro:** Inspect the accessibility tree of `.cal__grid`.
- **Expected:** One pattern. Either a `grid` whose `gridcell`s carry `aria-selected`, or a plain table of toggle buttons.
- **Actual:**
  - The `<table role="grid">` puts `aria-selected` on the `<td>` and also `aria-pressed` on the inner `<button>`.
  - Out-of-month cells are empty `role=gridcell`s.
  - Screen readers announce both "selected" and "pressed". Keyboard behaviour itself is correct (see Passed).
- **Suspected:** `DatePicker.tsx:193-233`.
- **Fix:** Keep `role=grid` and `aria-selected` on the cell, and remove `aria-pressed`. Alternatively drop `role=grid` and keep the buttons with `aria-pressed`.
- **Resolution (Fixer B, UI):** One pattern: `role=grid` with `aria-selected` on the cell; the inner button no longer has `aria-pressed` (styling uses `data-selected`). e2e checks the cell's `aria-selected` and zero `aria-pressed`.

### A11Y-9: Inactive owner tabs point `aria-controls` at panels that don't exist. **Low**
- **Where:** `/owner`, all widths.
- **Repro:** For each `[role=tab]`, check `document.getElementById(aria-controls)`. The results are `tab-orders→panel-orders: false`, and the same for the other 5 inactive tabs.
- **Suspected:** `OwnerDashboard.tsx:699` with a single tabpanel at `:708-711`.
- **Fix:** Set `aria-controls` only on the selected tab, or render all panels with `hidden`.
- **Resolution (Fixer B, UI):** Only the selected tab carries `aria-controls`, pointing at the rendered panel (wide screens). Below 1024px there is no tablist (a labelled "View" select) and the panel is a labelled region. e2e asserts exactly one `aria-controls` that resolves.

### A11Y-10: Duplicate landmark name on the chat page. **Low**
- **Where:** Chat, 1440 (the aside is visible at ≥1024).
- **Actual:** `<aside aria-label="How the agent answered">` contains `<section aria-labelledby=…>` that resolves to the same "How the agent answered". Landmark navigation lists it twice: once as complementary, once as region.
- **Suspected:** `ChatApp.tsx:606`, `TracePanel.tsx:225`.
- **Fix:** Drop the `aria-label` on the aside and use `aria-labelledby` pointing at the panel's h2, then make the inner `<section>` a `<div>`.
- **Resolution (Fixer B, UI):** The aside is `aria-labelledby` the panel's h2 and the inner wrapper is a plain div, so there is one landmark named "How the agent answered".

### A11Y-11: Unavailable calendar dates use the "decorative only" grey for text. **Low**
- **Where:** Booking calendar, all widths.
- **Actual:** Numbers on `aria-disabled` days render `#86868b` on `#fff` = **3.62:1**. This is exempt as an inactive control, but it contradicts the token rule `--subtle … not for text` (`globals.css:15`) and makes valid dates hard to read.
- **Suspected:** `globals.css:2031`.
- **Fix:** Use `--muted` (`#6e6e73`, 5.1:1) and convey unavailability with weight or fill instead.
- **Resolution (Fixer B, UI):** Unavailable day numbers use `--muted` (#6e6e73, 5.1:1) at normal weight; availability is carried by bold + dot.

### A11Y-12: Some motion falls outside the 200–400ms ease-out rule. **Low**
- **Where:** All widths.
- **Actual:**
  - `.trace-step { transition: box-shadow 600ms }` (`globals.css:2656-2658`).
  - Typing dots `1.2s ease-in-out infinite` (`:1266`).
  - Spinner `700ms linear infinite` (`:387`). Loaders are acceptable.
  - The trace highlight holds for 1.8s (`ChatApp.tsx:328`).
- **Positive:** Under reduced motion the CSS durations collapse to 0.01ms (verified on `.btn`, `.biz-card` and `.skip-link`).
- **Fix:** Use `var(--t-slow)` for the highlight fade. Leave the loaders or slow them under reduce.
- **Resolution (Fixer B, UI):** The trace highlight fade uses `var(--t-slow)` (400ms). Typing dots/spinner are loaders and stop after one iteration under reduced motion (global reduce rule) — kept.

### A11Y-13: Required state isn't exposed on the status and login fields. **Low**
- **Where:** `/status` and `/owner/login`.
- **Actual:** Checkout fields set `aria-required`, but `#status-reference`, `#status-email`, `#owner-username` and `#owner-password` do not. Screen readers only learn these fields are required from the error after submitting.
- **Suspected:** `StatusLookupForm.tsx:150-185`, `OwnerLoginForm.tsx:80-120`.
- **Fix:** Add `aria-required="true"`, or `required` while keeping `noValidate`.
- **Resolution (Fixer B, UI):** `aria-required="true"` on the status reference/email and owner username/password fields (asserted in `ui-status-owner.spec.ts`).

---

## Visual / design defects (ranked by visual impact)

### VIS-1: The trace panel exposes internal noise in the product's signature feature. **High**
- **Where:** Chat trace aside (1440) and sheet (375/768), after any lookup.
- **Repro:** At 1440 send "I'd like to buy 2 please", or book on GreenStripe.
- **Problems seen:**
  - **A wall of 25 SKU chips** for `search_catalog`. Every catalog row shows as a monospace chip, about 13 rows of chips in one card.
  - **Raw database IDs** shown as data, e.g. `Slot cmuvy5lni00sfs4oymjtzi6gt` ×6 and `Checkout cmuvybvuv000q4coy10yfzzyr`. These mean nothing to a customer and look like a debug dump.
  - **Robot copy:** "25 match(es): EL-BOX-1G-NW $0.65 (398 in stock); …stock)…", "6 opening(s): 2026-10-06 8:00 AM…", "6 policy item(s)". The summaries contain ISO dates and are truncated with "…".
  - **An empty value row:** "Looked up with → Query" shows an empty right column (the stub's query is `""`).
  - **"0 ms"** shown on most steps.
- **Expected:** A calm, legible explanation. Apple-style restraint would mean a few human chips ("Romex 12/2", "Tue Oct 6, 8:00 AM"), counts instead of walls, and no internal IDs.
- **Suspected:**
  - `TracePanel.tsx:158-169` renders every dataRef.
  - `TracePanel.tsx:63-66`: `readable("")` returns `""` instead of "—".
  - `src/agent/tools.ts:391`, `:434`, `:444` build the summaries.
- **Fix:**
  - Cap chips at about 5 with "+20 more" behind a disclosure.
  - Hide `draft` and `slot` refs, or render slots as local times.
  - Pluralise properly and format dates in the business time zone.
  - Show "—" for empty strings.
  - Hide `ms` under 1, or show "<1 ms".
- **Resolution (Fixer A, server):** Server part fixed in `src/agent/tools.ts` (`summarizeToolOutput`: "25 matches: …", "6 openings: Tue Oct 13, 9:00 AM; …", "1 policy"; `dataRefsFor`: max 6 refs + `moreRefs`, slots as local times, drafts as "Checkout #xxxx", policies by title, no raw DB ids; `traceInput`: empty values and slot ids omitted, ISO dates → "Tue Oct 13") and `src/agent/runner.ts` (real `performance.now()` durations, minimum 1 ms); `TraceStep.moreRefs` added to `src/contracts/chat.ts`. Tests: `tests/unit/agent/hardening.test.ts` › "trace content (VIS-1)".
- **Resolution (Fixer B, UI):** UI part: `TracePanel` hides absent/0 ms timings, leaves empty input values out, never shows draft refs or raw cuid/uuid ids, caps chips at 5 with a "+N more" toggle (`aria-expanded`) plus the server's `moreRefs` count; raw JSON stays inside "Technical details". e2e: `ui-chat.spec.ts` › "trace hides noise".

### VIS-2: The LLM-unavailable fallback looks like a normal reply and points at a button that doesn't exist. **High**
- **Where:** Chat, all widths, real `llm_unavailable`. Server :3213 with `OASIS_FAULT=llm_error`.
- **Repro:** Send any message while the model fails.
- **Actual:**
  - The reply is a normal grey assistant bubble: "Sorry — I'm having trouble responding right now. Please try again in a moment, or use the **"Talk to a human" button**…"
  - No such button exists. The real control is a small "Email support" text link under the bubble.
  - There is no error styling and no "Try again", unlike the 429 card, so the two failure modes look completely different.
  - The trace also reports "1 lookup" for the failed turn.
- **Suspected:** `src/agent/runner.ts:238-242` (copy). `ChatApp.tsx:216-233` renders the error card only when `blocks.length === 0`.
- **Fix:** Change the copy to "use **Email support** below". Render fallback turns with the error-card treatment, including "Try again".
- **Resolution (Fixer A, server):** Server part fixed in `src/agent/runner.ts` (`fallbackText`: every fallback points to the "Talk to a person" button below or the business support email). Test: `tests/unit/agent/hardening.test.ts` › "points at the Talk to a person button or the support email — never a missing button".
- **Resolution (Fixer B, UI):** UI part: replies with `fallback`/`error` render in the error treatment (attention tint, alert icon) with "Try again" and "Talk to a person"; Try again replaces the card and re-sends without a second user bubble. "Talk to a person" is also always in the composer area. e2e: `ui-chat.spec.ts` › "a fallback reply is styled as an error".

### VIS-3: The status result shows a raw service slug. **High**
- **Where:** `/status` → found booking, all widths.
- **Repro:** Look up a GreenStripe booking.
- **Actual:** The subtitle reads "**lawn-mowing** — Extra small (up to 1/8 acre), 25 min". The order variant reads "2 item(s): …".
- **Expected:** "Lawn mowing visit — Extra small (up to 1/8 acre) · about 25 min" and "2 items: …".
- **Suspected:** `src/domain/status.ts:92` (`bk.serviceCode`), `:76` (`item(s)`).
- **Fix:** Resolve the service name from the catalog, pluralise, and use the shared duration formatter.
- **Resolution (Fixer A, server):** Fixed in `src/domain/status.ts`: bookings return `serviceName` ("Lawn mowing visit") and summary "Lawn mowing visit — Extra small … · about 25 min"; orders return `itemsLabel` ("1 item"/"3 items"); `/api/status` passes both (`src/contracts/tools.ts`). Test: `tests/unit/agent/hardening.test.ts` › "VIS-3/WF-4: status returns the service NAME and readable item counts".
- **Resolution (Fixer B, UI):** UI part: the status result leads with `serviceName` / `itemsLabel` ("2 items"), then the summary; no raw code or "item(s)". e2e asserts "2 items".

### VIS-4: More colour than the one-accent system allows. **Medium**
- **Where:** Owner Inventory, Availability and Conversations; the chat trace.
- **Rendered colours** collected across all states, beyond ink, greys and accent: `#b42318 #fdf0ee` (danger), `#7a4b00 #fff6e5` (warn), `#116b3a #ebf7ef` (ok), `#8a1c1c #fde8e8` ("Test mode" pill, a second red that isn't a token), `#f2eada` (code chip), `#b9dcdf`, `#d3eaec`.
- **Worst offenders:**
  - The Inventory table paints whole rows pink (6) and amber (9) above a column of green "In stock" pills, a traffic-light look.
  - Availability tiles mix teal, pink and grey.
  - Conversation outcome badges are green.
- **Suspected:** `globals.css:1621-1626` (`.trace-testmode`). Inventory/availability row and tile styles are in the owner section of `globals.css`.
- **Fix:**
  - Keep a single status colour: danger only for "Out of stock" and "0 open".
  - Show low stock as bold ink plus a small dot, not a row fill.
  - Make "In stock" plain text.
  - Use `--danger` / `--danger-tint` for "Test mode".
- **Resolution (Fixer B, UI):** Tokens: one accent + neutrals + a single `--attention` (#b42318); warn/ok tokens and the stray #8a1c1c/#fde8e8/#b9dcdf/#d3eaec literals are gone (Test-mode badge uses attention). Owner: no row fills; "Out of stock", open escalations, cancelled/failed and "0 open" use attention; low stock is bold ink + ring dot "Running low"; "In stock" is muted text; outcomes are neutral word badges except Escalated; availability tiles are white/neutral with a legend. e2e asserts no inventory row fill.

### VIS-5: Owner tabs overflow at 768 as well as 375, with no affordance. **Medium**
- **Where:** `/owner` at 375 and 768.
- **Repro:** Measure `.tabs` `scrollWidth`/`clientWidth`: **738/712 at 768** and 738/351 at 375.
- **Actual:**
  - At 768 the strip scrolls by 26px. With "Conversations" selected the first tab is clipped to "**verview**".
  - At 375 "**Inventor**" is cut at the edge.
  - Neither width has a fade or chevron to hint at more tabs.
- **Suspected:** `globals.css:2164-2190` (`.tabs`, `.tab` padding).
- **Fix:** Reduce `.tab` padding or font from 768px up so 7 tabs fit in 712px. Below that, add a right-edge mask gradient, or switch to a `<select>` on phone.
- **Resolution (Fixer B, UI):** Below 1024px a labelled "View" select replaces the tablist (no clipped tabs at 375/768); from 1024px all eight tabs fit in one row with 44px height (e2e asserts tablist `scrollWidth <= clientWidth`).

### VIS-6: The checkout card repeats itself and leaves an orphan in the review grid. **Medium**
- **Where:** Booking and product checkout, all widths.
- **Actual:**
  - The booking title "Lawn mowing visit · Extra small (up to 1/8 acre)" is followed by the subtitle "Lawn mowing visit — Extra small (up to 1/8 acre) (about 25 min)". That is the same words twice.
  - The product title carries the SKU: "2 × 1-gang new-work PVC box, 18 cu in (EL-BOX-1G-NW)".
  - The review lists the items in an "Items" block and again in the "Price" table.
  - At 768/1440 the 2-column review grid leaves "Ship to" alone, with an empty right cell.
- **Suspected:** `CheckoutForm.tsx:489-492` (title/summary), `:615-641` (review grid).
- **Fix:**
  - Use the subtitle only for what's new ("About 25 min").
  - Strip the SKU from the title.
  - Drop the "Items" block, since Price already lists the items.
  - Place Contact and Ship-to side by side and the Appointment block full width.
- **Resolution (Fixer B, UI):** Product title drops SKUs ("2 × Romex …, 250 ft"); service subtitle shows only what the title doesn't (add-ons + "About 2 hr 30 min"); the review no longer repeats items (Price lists them); Appointment spans the full width with Contact and Ship-to side by side. e2e asserts title, subtitle and no "Items" heading.

### VIS-7: The rate-limit card contradicts itself and breaks an email address. **Medium**
- **Where:** Chat 429, 375 (also seen at 768).
- **Actual:**
  - The copy says "Wait a minute, then try again", but "Try again" is enabled immediately and will 429 again.
  - At 375 the support address wraps mid-word as "support@mountpro-" / "tv.example.com".
  - The whole body text is in danger red, which is heavy.
- **Suspected:** `ChatApp.tsx:448-483`.
- **Fix:**
  - Disable "Try again" with a short countdown, or use Retry-After when present.
  - Apply `overflow-wrap: anywhere` / `word-break: break-all` only to the mailto link.
  - Keep the title red and set the body in `--ink-2`.
- **Resolution (Fixer B, UI):** 429 uses Retry-After (default 30s): "Try again" is disabled with a live countdown ("Try again in 12s"); copy says it unlocks when the wait is over. Body text is ink-2 with only the title in attention red; the mailto link is an inline-block with `overflow-wrap:anywhere`, so it moves whole to its own line. e2e: `ui-chat.spec.ts` › "rate limit waits for Retry-After".

### VIS-8: The phone field uses a placeholder that reads as a value. **Low**
- **Where:** Checkout "Mobile phone", all widths. It is worst in the error state, where "(555) 555-0123" sits inside a red-bordered field above "Enter a 10-digit US phone number".
- **Suspected:** `CheckoutForm.tsx:797`.
- **Fix:** Move the example to a hint ("10-digit US number") and remove the placeholder.
- **Resolution (Fixer B, UI):** Phone placeholder removed; hint "10-digit US number" below the label.

### VIS-9: Home is repetitive. **Low**
- **Where:** `/`, all widths.
- **Actual:**
  - "Track an order" or "Track an order or booking" appears **4 times**: nav, hero secondary button, track band and footer.
  - Every card carries a "Products" or "Services" badge that only repeats its group heading ("Supply houses…" / "Home services…").
- **Fix:** Drop the hero secondary button, or the band. Remove the per-card badges.
- **Resolution (Fixer B, UI):** Hero "Track an order" button and the per-card Products/Services badges removed (group headings carry the kind). "Track" now appears in nav, the track band and the footer.

### VIS-10: The composer is cluttered. **Low**
- **Where:** Chat, all widths.
- **Actual:** "0 / 2,000" is always visible, and the 12px hint "Enter to send · Shift + Enter for a new line. Never type card numbers here." sits permanently under the field.
- **Suspected:** `ChatApp.tsx:593-601`, `globals.css:1371`, `:529`.
- **Fix:** Show the counter only past about 80% of the limit. Show the hint only on focus, or once.
- **Resolution (Fixer B, UI):** The character counter appears only from 80% of the limit; the keyboard hint shows only while the composer has focus (≥768px) and stays as the field description for screen readers. The meta row now holds the persistent "Talk to a person" control.

### VIS-11: The status timeline's future step reads as already done. **Low**
- **Where:** `/status`, found booking.
- **Actual:** The grey pending step says "Job completed — **The work is done.**"
- **Suspected:** `StatusLookupForm.tsx:29`.
- **Fix:** Use a future-tense description for pending steps ("We'll mark it done after the visit").
- **Resolution (Fixer B, UI):** Pending timeline steps use future-tense copy ("We'll mark it done after the visit", "It will be dropped off at your address").

### VIS-12: "Today" and timestamps disagree on time zone. **Low**
- **Where:** `/owner` Overview and `/status`.
- **Actual:**
  - At 20:40 local on Oct 5, the overview said "Today is **Tue, Oct 6**" (UTC) while counting orders shown as "**Oct 5**, 8:40 PM" as "today".
  - The status page shows "Appointment … 8:00 AM CDT" next to "Placed Oct 5, 8:40 PM" with no zone.
- **Fix:** Pick one zone (the business zone, or the browser zone for the owner) and label the times.
- **Resolution (Fixer B, UI):** Every owner/status timestamp shows its zone (`formatDateTimeZoned`, e.g. "Oct 5, 8:40 PM CDT"); bookings use the server's `localStart` in the business zone; the overview says `"Today" is Tue, Oct 6, UTC`.

### VIS-13: The empty-reference error repeats the hint. **Low**
- **Where:** `/status` → submit empty.
- **Actual:** The error "Reference looks like OAS-ABCD-2345" sits directly under the hint "Looks like OAS-ABCD-2345…".
- **Suspected:** `src/contracts/common.ts:28` is used for both the empty case and the malformed case.
- **Fix:** For an empty value, show "Enter your reference number".
- **Resolution (Fixer B, UI):** UI-side: an empty reference shows "Enter your reference number" (empty email: "Enter the email you used") instead of repeating the format hint. e2e asserts it.

### VIS-14: Ambiguous chat header icons on phone. **Low**
- **Where:** Chat at 375.
- **Actual:**
  - The back link is a chevron plus the Oasis mark, which reads as a person/avatar icon.
  - "Start over" is a bare refresh glyph, easily mistaken for "reload".
- **Suspected:** `ChatApp.tsx:346-349`, `:381-390`.
- **Fix:** Use the chevron alone with an "Oasis" text label, or the wordmark. Keep "Start over" as text, or put it in an overflow menu.
- **Resolution (Fixer B, UI):** Back link is a chevron (+ "oasis" wordmark from 600px), 44×44; "Start over" is always a text button; the Trace button drops its icon on phone to make room.

### VIS-15: The model step mislabels its data. **Low**
- **Where:** Trace, all widths.
- **Actual:** "Why: oasis-test-stub · 2 calls, 1 tool round" puts model metadata under a "Why" label, then the usage line below repeats the model, tokens and cost.
- **Suspected:** Model-step construction in `src/agent/runner.ts`, and `TracePanel.tsx:131-136`.
- **Fix:** For `kind === "model"`, omit "Why" and show only the usage line.
- **Resolution (Fixer B, UI):** Model steps no longer render a "Why:" row; the usage line carries model/tokens/cost. e2e asserts no why row on model steps.

### VIS-16: The owner data views are dense. **Low**
- **Where:** Owner Inventory (1440) and Orders (375).
- **Actual:**
  - Inventory is one 50-row table with no search, grouping or pagination, about 3,000px tall.
  - On phone, each order card has 8 label/value rows, including the unexplained jargon "Zone 5".
- **Fix:**
  - Group inventory by business and collapse "In stock" rows behind "Show all".
  - On phone, show Reference, Total and Status, with the rest behind a disclosure.
  - Rename "Zone" to "Shipping zone", or drop it.
- **Resolution (Fixer B, UI):** Inventory shows out/low first plus 8 in-stock rows, the rest behind "Show all N products" (`aria-expanded`); "Zone" renamed "Shipping zone". Not done: a phone-only disclosure for order cards (8 short rows stay readable at 375; the stacked layout already avoids horizontal scroll).

---

## Top 10 issues

1. **A11Y-1 (High).** Focus drops to `<body>` on every checkout step change: review, edit and confirm.
2. **VIS-1 (High).** The trace panel shows raw IDs, a wall of 25 chips, "match(es)" copy, an empty Query value and "0 ms".
3. **VIS-2 (High).** The LLM-unavailable reply points at a nonexistent "Talk to a human" button and isn't styled as an error.
4. **VIS-3 (High).** The status page shows the raw slug "lawn-mowing" and "item(s)".
5. **A11Y-3 (Medium).** Input, select and time-slot borders are 1.51:1, and available days are marked by a 1.14:1 tint (WCAG 1.4.11).
6. **A11Y-4 (Medium).** The input focus ring is effectively 1px. On invalid fields, focus is nearly invisible.
7. **A11Y-2 (Medium).** JS `behavior: "smooth"` ignores reduced motion (measured).
8. **A11Y-5 / A11Y-14 (Medium).** Mobile tap targets are 24-42px, and the composer keeps focus (and the soft keyboard) after a form arrives.
9. **VIS-4 / VIS-5 (Medium).** The owner views use traffic-light colours beyond the single accent, and the tabs overflow at 768 ("verview") and 375 ("Inventor").
10. **VIS-6 / VIS-7 (Medium).** The checkout card repeats itself and leaves an orphan review cell. The rate-limit card offers an instant "Try again" despite "wait a minute", and breaks the email address mid-word.

## Passed

- **No horizontal page scroll:** `scrollWidth === clientWidth` on every page and state at 375, 768 and 1440, chat included. The only inner horizontal scrollers are the intended owner tab strip and the tables.
- **Headings:** exactly one `h1` on every page.
- **Labels and names:** every input, select and textarea has a label, and every button and link has an accessible name.
- **Language and images:** `lang="en"` is set. Every SVG is `aria-hidden`, and there are no `<img>` elements without alt.
- **Text contrast:** every enabled text/background pair actually rendered passes AA (the lowest is `#0a7c86` on `#f5f5f7` at 4.55:1). Placeholders are `#6e6e73` at ≥ 4.9:1.
- **Focus ring:** the global ring (3px `#0a7c86`, offset 2px) is 4.5-4.95:1 against every background it sits on (`#fff`, `#f5f5f7`, `#fbfbfd`).
- **Skip link:** it becomes visible at top 12px and moves focus to `#main` on home, status, owner and chat.
- **Tab order:** logical on home, chat, status, login and owner. No element receives focus without a visible indicator (the composer shows its ring on `.composer__box` via `:focus-within`).
- **Trace sheet:**
  - Opens via keyboard with initial focus on Close.
  - Background is inert, with no leak to the page behind.
  - Escape closes it and returns focus to the trigger.
  - "N lookups: see how it answered" opens the sheet and focuses the right reply group; closing returns focus to that link.
  - A backdrop click closes it.
- **Desktop trace link:** focuses the matching group in the aside, with a visible outline.
- **Date grid:**
  - Roving tabindex with a single tab stop.
  - Arrow keys, Home, End, PageUp and PageDown all work, with month changes announced via `aria-live`.
  - Enter on an `aria-disabled` day does not select it; Space on an available day selects it and loads times.
  - Tab moves into the time radios, and the arrow keys change the radio selection.
- **Owner tabs:** ArrowLeft/Right wrap, Home/End work, and selection follows focus. The tabpanel is focusable, and on phone the selected tab scrolls into view.
- **Composer:** Enter sends, Shift+Enter inserts a newline without sending, and focus stays in the composer.
- **Live regions:**
  - The "assistant is typing…" status and the reply text (with "A secure form is ready below.") are announced politely.
  - Checkout success uses `role=status`.
  - Login, status and checkout errors focus the first invalid field, which has `aria-invalid` and an `aria-describedby` error.
  - The status result is focused after lookup.
- **Landmarks:** header, main and footer, with labelled Main/Footer navs. The chat has a header, main and a labelled aside.
- **Motion:** the base tokens are 200/300/400ms on `cubic-bezier(0.22,1,0.36,1)` (ease-out). With reduced motion emulated, CSS transitions and animations drop to 0.01ms and `scroll-behavior` becomes `auto`.
- **Console:** no console or page errors, apart from the expected 404s on the not-found pages and one 401 resource log around owner sign-out.
- **Fixes from earlier design rounds hold:**
  - The chat header and trace stay fixed during confirm.
  - No dead "Start over" on an empty chat.
  - The footer is pinned on short pages.
  - The tablet home grid has no orphan card.
  - The availability tiles align.
