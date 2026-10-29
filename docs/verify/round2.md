# Verify round 2: fix confirmation + regression hunt

Date: 2026-10-06. Verifier: round-2 verify agent. This is a report only: nothing under `src/`, `tests/`, `prisma/`, `evals/` or config was changed.

## Setup

- **Build.** The `.next` build (BUILD_ID `OrPhWYFjXENeAnAZvQvRi`) was fresh: no file under `src/` was newer, so I did not rebuild.
- **Database.** Own DB at `.data/verify-r2/oasis.db`, migrated and seeded like `tests/e2e/global-setup.ts`. Outbox at `.data/verify-r2/outbox`.
- **Server.** One server at a time on **:3401**, with `APP_URL=http://localhost:3401`, `OASIS_LLM_STUB=1` (except where noted) and no provider keys. Configurations, in order:
  1. `next start` with default rate limits (security repros)
  2. `next start` with lifted limits (functional repros and browser flows)
  3. four start-up runs for the demo-secret refusal matrix
  4. `next dev` with exactly the `.env.example` values (quick-start)
  5. `next start` with `TRUST_PROXY=true` behind a Node reverse proxy on :3402 (append-mode XFF, like nginx `$proxy_add_x_forwarded_for`)
  6. no stub, `OASIS_MAX_TURNS=2`
  7. `RATE_LIMIT_IP_PER_10MIN=2` (429 card)
  8. no stub, no key (fallback card)
- **Real client addresses.** Requests came from three distinct socket addresses: `127.0.0.1`, `::1` and the LAN address `192.168.1.23`. This tested per-client limits without relying on `X-Forwarded-For`.
- **Agent layer.** Throwaway vitest harness `.data/verify-r2/harness.test.ts` (config `vitest.verify.config.mts`), with the repo's fake LLM and a temp seeded DB.
- **Scripts.** All in `.data/verify-r2/`:
  - API and security: `sec2.mjs`, `loginguard.mjs`, `sessions.mjs`, `api.mjs`, `api2.mjs`, `devcheck.mjs`, `proxycheck.mjs`, `rproxy.mjs`
  - ZIP pairs: `zips.ts`
  - Browser: `ui.mjs`, `ui-pages.mjs`, `ui-static.mjs`, `vis.mjs`, `rl.mjs`
  - Results files: `ui-results-*.txt`, `ui-pages-results.txt`, `harness-results.txt`. Screenshots are in `shots/`.
- **Cleanup.** All servers and the proxy are stopped, and ports 3401/3402 are free.

## Gates

| Gate | Result |
|---|---|
| `npm run lint` | exit 0, no findings |
| `npm run typecheck` | exit 0 |
| `npm test` | **25 files, 430 tests passed** (6.9 s) |
| `npm run format:check` | "All matched files use Prettier code style!" |

`test:e2e` was not run, as instructed; the coordinator ran it green.

## Round-1 findings by status

| Status | Count | IDs |
|---|---|---|
| CONFIRMED FIXED | 65 | SEC-1–12, ISO-1–2, INJ-1–5, ADV-1, ADV-2, ADV-4, ADV-5, WF-1–7, EDGE-1–7, A11Y-1–11, A11Y-13, A11Y-14, VIS-1–15 |
| PARTIAL (scope accepted, by design) | 3 | ADV-3, A11Y-12, VIS-16 |
| STILL BROKEN | 0 | none |
| Won't fix / documented: justification acceptable | 2 | SEC-13, EDGE-8 |

ADV-1 and EDGE-1 are fixed: territories can now check out. The new ZIP↔state cross-check added with that fix, however, introduces regression **R2-1**.

### Evidence per finding

**Security**

| ID | Status | Re-run evidence |
|---|---|---|
| SEC-1 | CONFIRMED | `next start` + `APP_URL=https://shop.example.com` + demo secrets: logs `env_invalid` "Refusing to start … OWNER_PASSWORD_HASH, SESSION_SECRET, OASIS_ENCRYPTION_KEY, OASIS_HMAC_KEY … (Throwaway public demo only: OASIS_ALLOW_DEMO_SECRETS=true.)", **exit 1**. With real secrets it starts. With `OASIS_ALLOW_DEMO_SECRETS=true` it starts and logs `demo_secrets_in_production` (error). On localhost it starts with the `DEMO SECRETS IN USE` warning. Overview returns `demoCredentials:true`, `demoSecrets:[all 4]`. A forged far-future token gives 401. |
| SEC-2 | CONFIRMED | `next start`, one real peer, rotating `X-Forwarded-For` + `X-Real-IP`: login `401×5, 429×3`. Status with a forged `x-oasis-peer: deadbeef:10.1.1.n` + rotating XFF: `200×10, 429×2`. Another real peer (`::1`) has its own bucket (200s). The same holds under **`next dev`** (Turbopack): `401×5, 429×2`. Behind an append-mode proxy with `TRUST_PROXY=true`, client-rotated XFF still gives `401×5, 429×2` (the right-most entry is the real peer). |
| SEC-3 | CONFIRMED | The draft GET without a conversation, or with the attacker's own conversation, gives 404. Slots without a conversation give 400. Attacker review/confirm give 404. A confirm without `conversationId` gives 400. After the victim confirms, the attacker's confirm gives 404 (no reference leaked). The victim's replay gives 200 `replayed:true`. |
| SEC-4 | CONFIRMED | Logout in session A: A's cookie gets 401 on the API and a 307 to login on `/owner`. Session B (another login) stays 200. Forged tokens (far exp, unknown sid, old format without sid) give 401. A restart signs the owner out (401/307), which is expected and fail-closed. Browser, two tabs: sign-out in tab 2 sends tab 1 to `/owner/login` on its next fetch. |
| SEC-5 | CONFIRMED | 100 KB chat body gives 413. 5 MB status body gives 413. A chunked 200 KB review (no content-length) gives 413. |
| SEC-6 | CONFIRMED | `address2:"Apt\r\nBcc:…"`, `address1` with `\n`, NUL, U+202E or U+200B give 422 "Remove line breaks and special or invisible characters". Instructions keep `\n` but lose BEL/RLO (seen in the outbox). |
| SEC-7 | CONFIRMED | Production with `TRUST_PROXY=false`: `X-Forwarded-Host: evil.com` + `Origin: https://evil.com` gives 403, and `Host: evil.com` + `Origin: http://evil.com` gives 403. |
| SEC-8 | CONFIRMED | Logging out session A with B's CSRF token gives 403. A planted `AAAA…` cookie/header pair gives 403. |
| SEC-9 | CONFIRMED | A `checkout_completed` (and `checkout_cancelled`) event for a foreign-conversation draft gets "I couldn't verify that checkout in this chat…". A checkout event without a conversation gives 400 "Checkout events need their conversation." |
| SEC-10 | CONFIRMED | Harness with status limit 3: `lookup_status` in one conversation from 5 different IPs returns `ok,ok,ok,RL,RL`. |
| SEC-11 | CONFIRMED | Conversation and draft ids are 22-char base64url (128-bit), e.g. `56xBvYDbxKxN72Py5qLcWA`. |
| SEC-12 | CONFIRMED | Business email subject: "New order OAS-NT4B-NPLW for Volt & Wire Electrical Supply — $10.35". No customer name appears in any stored notification subject. |
| SEC-13 | WON'T FIX: acceptable | Transitive through the Prisma CLI only (mysql2 is unused with SQLite; deepmerge-ts only merges local config). The only "fix" downgrades Prisma. Fine for a demo; keep re-auditing. |

**Isolation and injection**

| ID | Status | Re-run evidence |
|---|---|---|
| ISO-1 | CONFIRMED | See SEC-9. The foreign conversation's outcome is not changed. |
| ISO-2 | CONFIRMED | Overview: all = orders 1 / bookings 1 / escalations 2 / low 9 / out 6. `?businessId=volt-supply` = 1/0/0/4/3. `mountpro-tv` = 0/1/0/0/0. |
| INJ-1 | CONFIRMED | Harness, 12 turns with a tag payload in turn 1. The summary shows `[tag removed]…[tag removed]`, sits in the first **user** message as `conversation_summary`, and the `runTurn` system prompt does not contain the payload. |
| INJ-2 | CONFIRMED | Harness, 25 `escalate_to_support` calls in one response: 1 escalation row, 1 support email, 21 `too_many_tool_calls` results. |
| INJ-3 | CONFIRMED | Harness: exact, lower-case, hex-only, spaced, zero-width-split, fullwidth and 8-hex-half variants are all blocked. 3 benign replies are not blocked. |
| INJ-4 | CONFIRMED | Harness: Unicode tag characters, U+00AD, U+034F, U+FE0F and U+E0100 are stripped (`"hithere"`). |
| INJ-5 | CONFIRMED | Harness: email and phone numbers are redacted from the escalation email. Live: the note becomes "Please call Jane Roe at [phone removed], [email removed]"; only the explicit `contactEmail` is kept. Typed names survive, see R2-5. |

**Adversarial input**

| ID | Status | Re-run evidence |
|---|---|---|
| ADV-1 | CONFIRMED | PR 00901, GU 96910, VI 00802, AS 96799 and MP 96950 give 200, zone 8, $14.30 shipping. The "San Juan, NY 00901" workaround is now refused. See R2-1 for the cross-check regression. |
| ADV-2 | CONFIRMED | See SEC-6. A newline in city gives 422. |
| ADV-3 | PARTIAL (accepted) | `00000` and `00412` give "That ZIP code doesn't exist". `99999` is still accepted (documented choice: only 000–004 are checked). One authoritative table lists 004 as NY, see R2-8. |
| ADV-4 | CONFIRMED | `jane@bücher.de` gives 200 (punycode). A Unicode local part gives 422 (documented). `x123` extension gives "Remove the extension…". Fullwidth digits give 200. `787011234` is accepted as ZIP+4. |
| ADV-5 | CONFIRMED | 20,001 chars gives 400 `input_too_long`. 2,000 × U+FDFA gives 400 `input_too_long` (no silent truncation). |

**Workflows**

| ID | Status | Re-run evidence |
|---|---|---|
| WF-1 | CONFIRMED | `request_human` works with **no API key** (`next dev` quick-start and the no-stub `next start`), past the message cap (`OASIS_MAX_TURNS=2`, after a 429 `session_limit`) and in the stub. It dedupes within 10 minutes: the second request gives "You're already in line… ESC-9EZU-6VWT" and 1 email. Browser at 375/1440: "Talk to a person", send, ESC ticket in the reply. |
| WF-2 | CONFIRMED | `/api/owner/escalations` lists tickets with masked contact; transcript API returns 200; unauthenticated gives 401. The Escalations view and transcript dialog pass axe at 375 and 1440, and focus returns to the Transcript button on Escape. |
| WF-3 | CONFIRMED | API: the completed draft view total is 1035 (shipping 895), equal to the confirm total. Browser, 15 flows: the total after reloading the success card equals the confirmed total. |
| WF-4 | CONFIRMED | Status: `serviceName:"TV wall mounting"`, summary "TV wall mounting — Small (up to 42") · about 45 min". |
| WF-5 | CONFIRMED | SMS: "Volt & Wire: New order OAS-… — Zelda Q., 2 items, $10.35". The business email names the business in subject and body. |
| WF-6 | CONFIRMED | Covered by the e2e run; the retry path in the 429/fallback cards behaves as designed (one card, no duplicate bubble seen in my runs). |
| WF-7 | CONFIRMED | Bookings rows carry `timezoneLabel:"MDT"` and `localStart:"Wed, Oct 7, 2026, 9:00 AM MDT"`. |

**Edge cases**

| ID | Status | Re-run evidence |
|---|---|---|
| EDGE-1 | CONFIRMED | See ADV-1. Regression in R2-1. |
| EDGE-2 | CONFIRMED | Harness: the 645-minute move-clean `start_checkout` returns `requires_on_site_estimate` with an explanation, and `quote_service` sets `requiresOnSiteEstimate:true`. |
| EDGE-3 | CONFIRMED | Sunday 2026-11-01 returns "MountPro is closed on Sundays, so 2026-11-01 has no appointments…". |
| EDGE-4 | CONFIRMED | Harness with injected `now`: the first offered start is 170 min out at 08:10 local on Wed 10-07, Sat 10-31 (before DST ends) and Mon 11-02 (after). Never under 120. Confirm refuses a slot 50 min out and accepts one 170 min out. Seed fixtures sit ≥ today+7 days, so the lead time never touches them. DST is handled because the lead time is absolute milliseconds. |
| EDGE-5 | CONFIRMED | A raw hash in the process env while `.env` also defines it gives "OWNER_PASSWORD_HASH: looks corrupted — its `$` signs were probably expanded…", **exit 1** (no half-started listener). The escaped form starts. |
| EDGE-6 | CONFIRMED | Browser, 15 flows: after a reload mid-form, typed name, email and the chosen time are restored. After confirm, sessionStorage holds no PII (only reference and total). |
| EDGE-7 | CONFIRMED | "I'd like to order …" and "Can I book …" reach a form for all 5 businesses with the stub. |
| EDGE-8 | DOCUMENTED: acceptable | Pricing notes only; there is no defect to fix. |

**Accessibility**

| ID | Status | Re-run evidence |
|---|---|---|
| A11Y-1 | CONFIRMED | 15 flows: the review heading is focused after Review, the form h2 after Edit details, and "Order confirmed"/"You're booked" after Confirm. |
| A11Y-2 | CONFIRMED | `reducedMotion:"reduce"`: every recorded scripted scroll used behaviour `auto`, never `smooth`, and CSS transitions are 0.01 ms. |
| A11Y-3 | CONFIRMED | Input border is `rgb(134,134,139)`. |
| A11Y-4 | CONFIRMED | Focus outline is `solid 2px rgb(10,124,134)`, offset 2px. |
| A11Y-5 | CONFIRMED | 375: 0 targets under 44px on every chat, form, status and owner state measured. |
| A11Y-6 | CONFIRMED | axe at 375 and 1440 over all flow states (60 runs): 0 violations of any impact. |
| A11Y-7 | CONFIRMED | No `role=alert` in the message list on the 429 card. |
| A11Y-8 | CONFIRMED | 0 `aria-pressed` on calendar days. |
| A11Y-9 | CONFIRMED | Exactly one `aria-controls`, and it resolves. |
| A11Y-10 | CONFIRMED | A single "How the agent answered" landmark. |
| A11Y-11 | CONFIRMED | Unavailable days use `rgb(110,110,115)`. |
| A11Y-12 | PARTIAL (accepted) | The highlight now uses `--t-slow`. Loaders are kept, which is reasonable. |
| A11Y-13 | CONFIRMED | `aria-required="true"` on the status and login fields. |
| A11Y-14 | CONFIRMED | On every flow the new form's h2 is focused after send, not the composer. |

**Visual**

| ID | Status | Re-run evidence |
|---|---|---|
| VIS-1 | CONFIRMED | Harness: "25 matches: …; and 22 more", 6 refs + `moreRefs:19`, no empty inputs. The 1440 screenshot shows 5 chips + "+7 more". |
| VIS-2 | CONFIRMED | No key, 375: the fallback is an attention-tinted card with an icon, "Try again" and "Talk to a person", and its copy names a button that exists. See R2-6 for an email wrap. |
| VIS-3 | CONFIRMED | Status shows "TV wall mounting" and "2 items". No slug and no "(s)" on the page. |
| VIS-4 | CONFIRMED | No inventory row fills. |
| VIS-5 | CONFIRMED | The 1440 tablist fits. The 375 view uses a select. |
| VIS-6 | CONFIRMED | Subtitle shows "About 25 min" only. No SKU in the title. |
| VIS-7 | CONFIRMED | 429 at 375: "Try again in 227s", disabled, counting down. The mailto link is inline-block with `overflow-wrap:anywhere` on one line. |
| VIS-8 | CONFIRMED | No phone placeholder. |
| VIS-9 | CONFIRMED | Home: "Track an order" appears 3 times. 0 Products/Services badges. |
| VIS-10 | CONFIRMED | Screenshot: no counter at rest; the hint shows only on focus. |
| VIS-11 | CONFIRMED | "Job completed (upcoming) — We'll mark it done after the visit." |
| VIS-12 | CONFIRMED | "Placed Oct 6, 7:00 PM EDT" next to "Wed, Oct 7, 2026, 9:00 AM MDT": both have zones. |
| VIS-13 | CONFIRMED | Empty submit: "Enter your reference number" / "Enter the email you used". |
| VIS-14 | CONFIRMED | Back link is 44×44, chevron only at 375. "Start over" is a text button. |
| VIS-15 | CONFIRMED | Screenshot: the model step has no "Why:" row. |
| VIS-16 | PARTIAL (accepted) | "Show all N products" disclosure and "Shipping zone" are done. The phone order-card disclosure was skipped, with a reasonable justification. |

**Browser flow totals.** `ui.mjs` ran 5 businesses × 375/768/1440 against the real server with the stub: **284/284 checks passed**. Each flow covered:
- the form appearing
- empty-submit errors
- a reload mid-form
- review, edit, review
- a double-click on confirm
- reference and total
- a reload after success
- a single event pill
- PII leaving sessionStorage
- Start over followed by a new form
- no horizontal scroll and no console errors
- axe at 375 and 1440, and tap targets at 375

`ui-pages.mjs` ran home, 404 ×2, status (4 states), chat reply, trace sheet, Talk-to-a-person form and done states, owner login (+ errors), 8 owner views and the transcript dialog at 375 and 1440: **70/75 on the first pass**. The 5 misses were artifacts of my script:
- 3 axe `color-contrast` hits were captured mid fade-in. A re-check at +100 ms and +2 s found 0.
- 2 two-tab checks read the page before the redirect. A re-check shows tab 1 lands on `/owner/login`.

---

## Regression hunt

### Peer-address stamp (`src/guard/peer-address.ts`)
- **`next start`:** works. Real peers get separate buckets. A client-sent `x-oasis-peer`, single or with different casing, is ignored or overwritten. XFF and X-Real-IP are ignored when `TRUST_PROXY=false`.
- **`next dev` (Turbopack):** works the same way (`401×5, 429×2` from one peer with rotating XFF and a forged peer header; a second peer is unaffected).
- **Behind a proxy with `TRUST_PROXY=true`:** correct with an overwrite or append proxy. If the app port is also reachable directly, see R2-3.
- **Leakage:** the per-process secret header never appears in logs (grepped all 7 server logs) or responses.
- **Performance:** about one header delete and set per request, so negligible. A failure inside the stamp is caught and never breaks a request.
- **Stability:** the stamp only wraps `http.Server.prototype.emit`. An `https.Server`, such as `next dev --experimental-https`, does not inherit from it. Every client would then share the fallback key: 20× buckets and no trusted login address. This is dev-only and fails safe, so it is a note (R2-9), not a defect. I did not run it.

### Owner session store (in-memory)
- Login → restart → signed out, as expected and documented.
- Two logins are independent.
- Logout in one tab signs out the other tab, which shares the cookie, on its next request.
- The store works in both `next start` and `next dev`: the proxy and route handlers share `globalThis`.

### LoginGuard
- The owner on a known address signs in while the username is locked: 200. A new address is held off: 429 with Retry-After.
- The "known device" is a client **IP address**, not a device token. It cannot be stolen like a cookie, but it can be shared or forged in some deployments. See R2-3.

### conversationId binding / UI
- All 5 businesses × 3 widths complete end to end, including reload mid-form, reload after success and Start over (284/284).

### Lead time
- Covered under EDGE-4, including both sides of the DST change. No conflict with the seed fixtures.

### ZIP↔state check
- The prefix table matches the authoritative ranges ([stevemorse.org 3-digit prefix table](https://stevemorse.org/jcal/zip.html)). Where it differs it is more lenient: 055 MA/VT, 733 TX/OK, 832–838 ID/WY, 967 HI/AS, 969 GU/MP.
- The **hard reject** produces false rejections for real ZIPs that span two states. See R2-1.
- 76 real pairs were tested. The list of cross-state areas came from the Census ZCTA list ([peter-horton.com, 137 multi-state ZCTAs](https://peter-horton.com/2022/12/30/zip-codes-zctas-and-zctas-that-cross-state-boundaries/)).
- Results: **38 false rejects, 0 false accepts**. All edge prefixes passed:
  - territories: 005 NY, 006/007/009 PR, 008 VI, 969 GU/MP, 967/968 HI/AS
  - 995–999 AK
  - DC and Virginia: 200/202–205 DC, 201 VA, 569 DC
  - 386–397 MS, 398–399 GA
  - 885 TX, 733 TX, 471 IN
  - 83414 WY in an ID prefix
- APO/FPO is covered in R2-7.

### request_human
- Works with no API key, after the message cap, and dedupes within 10 minutes per conversation.
- The support email contains only the explicit `contactEmail`. Emails and phone numbers in the note are redacted, but names in the note survive (R2-5).
- Without a `conversationId`, the 10-minute dedupe is bypassed (R2-2).

### Demo-secret refusal and quick start
- Covered under SEC-1 and EDGE-5.
- **Quick start:** `next dev` with exactly the `.env.example` values works with zero edits:
  - the escaped hash resolves through `@next/env`
  - the server starts with the demo warning
  - the CSRF check passes on a non-3000 port in dev
  - chat without a key returns the friendly `llm_unconfigured` card ("Talk to a person" or email)
  - request_human returns an ESC ticket

### Accessibility spot check
- axe (wcag2a/aa, 21a/aa, 22aa, best-practice) on every page and state at 375 and 1440: **0 violations of any impact** after excluding mid-animation captures.
- Tap targets are ≥ 44 px at 375 everywhere measured.
- Focus moves correctly through every checkout step.
- Reduced motion is honoured.

---

## New defects

### R2-1 (Medium): ZIP↔state hard check rejects real addresses in ZIPs that span two states
- **Repro (live, `/api/checkout/review`):**
  - `zip:"99362", state:"OR"` gives 422 `{"zip":["ZIP 99362 is in WA, not OR. Check the ZIP or the state."]}`.
  - The same for `83120/ID` and `97635/CA`.
  - The pure-function run over 76 real pairs gives 38 false rejects, among them:
    - 02861 MA, 03579 ME, 19973 MD, 20135 WV, 21912 DE, 24604 WV, 30165 AL
    - 38326 MS, 42223 TN (Fort Campbell), 59221 ND
    - 71749 LA, 73949 TX, 79922 NM, 82063 CO
    - 83342 UT, 84034 NV, 86514 NM, 89010 CA, 89439 CA
    - 97910 ID, 99128 ID
- **Expected:** a customer can enter their real state. Shipping is priced by ZIP, so the state is informational, and round 1 recommended a soft warning.
- **Actual:** the only way to finish checkout is to enter a false state. That recreates the problem EDGE-1 set out to fix.
- **Where:**
  - `src/contracts/zip.ts:93-97` (`zipMatchesState`)
  - `src/contracts/customer.ts:234-235` (superRefine that adds the error)
- **Fix:**
  - Downgrade to a non-blocking warning in review ("ZIP 99362 is usually WA — is OR right?" with Continue).
  - Or keep the hard error only for prefixes that are entirely inside one state, with an allow-list of the ~137 multi-state ZCTAs (5-digit) that accepts either state.
  - Add a unit test with 99362/OR, 83120/ID and 42223/TN.
- **Resolution (round-2 fixer): FIXED — soft warning.** The `CustomerForm` superRefine is gone; ZIP↔state is never a field error. `zipStateWarning()` (`src/contracts/zip.ts`) builds "ZIP 99362 is usually in Washington — double-check your state.", `reviewCheckout` (`src/domain/checkout.ts`) puts it first in `CheckoutReview.warnings`, the review step shows it in the existing warning notice next to "Edit details", and confirm accepts the same details. Hard rejection stays only for impossible ZIPs (format, prefixes 000–003 incl. `00000`). Tests: `tests/unit/domain/checkout.test.ts` (99362/OR, 83120/ID, 97635/CA pass review with the warning AND confirm; 90210/TX gives exactly the warning; a matching state gives none; `00000` still 422), `tests/unit/contracts.test.ts` (mismatches incl. 42223/TN parse; warning text), e2e `fullstack-checkout.spec.ts` "R2-1/R2-7" at 375/768/1440 (Milton-Freewater, OR 99362 → warning on review → confirmed). No e2e asserted the old zip error. SPEC §5 updated.

### R2-2 (Low): `request_human` without a conversationId bypasses the escalation dedupe
- **Repro:** POST `/api/chat` 25 × `{businessId:"greenstripe-lawn", event:{type:"request_human"}}` (no `conversationId`) from one IP, with default limits.
- **Actual:** `200×20, 429×5`, and **20 support emails**.
  - Each call creates a new conversation and a new ESC ticket.
  - The 10-minute dedupe is per conversation only.
  - The only bound is the chat IP limit (20 per 10 min, so about 2,880 emails per IP per day), multiplied by every IP a botnet controls.
- **Expected:** "Talk to a person" cannot be used to flood the support inbox.
- **Where:**
  - `src/app/api/chat/route.ts:77` (human requests are exempt from the conversation requirement)
  - `:106-107`
  - `:141-142` (a new conversation is created per request)
  - `src/domain/escalation.ts` (dedupe keyed on the conversation)
- **Fix:** add a small per-IP escalation limiter (for example 3 per hour) and a per-business global cap (for example 30 per hour) that returns the existing ticket or a friendly "already received". Optionally require a conversation for `request_human` (the UI can create one first).
- **Resolution (round-2 fixer): FIXED.** `request_human` always runs in a conversation bound to the business slug (created when absent, like a normal chat; the UI keeps the returned id, so follow-up clicks hit the 10-minute dedupe). NEW tickets are capped by `checkEscalationRateLimit` (`src/guard/rate-limit.ts`): `RATE_LIMIT_ESCALATION_PER_HOUR` (3 per IP) and `RATE_LIMIT_ESCALATION_GLOBAL_PER_HOUR` (30 per business, all clients). A deduplicated repeat (`hasRecentOpenEscalation`) is not counted and still answers. Over the cap: 429 `escalation_limited` with Retry-After and "…Please email support@<business> and the team will help."; the chat shows a "We've already received your requests" card with the mailto link and no Try again / Talk to a person buttons. Tests: `tests/unit/agent/route.test.ts` (5 calls from one IP → `200,200,200,429,429`, exactly 3 new Escalation rows, dedupe still 200; per-business cap across 3 IPs; conversation bound to the business), e2e `ui-chat.spec.ts` "too many hand-off requests" (axe clean). Env documented in `.env.example`, SPEC §8.

### R2-3 (Low): LoginGuard "known device" is a client IP address
- **Repro:**
  1. Start with `TRUST_PROXY=true`, with the app port also reachable directly (a common misdeploy).
  2. The owner signs in from `::1` through the proxy.
  3. An attacker locks the username (5 × 401).
  4. A direct request with `X-Forwarded-For: ::1` gets **401** (password checked, so the lock is bypassed) instead of 429.
- **Also:**
  - Anyone behind the owner's NAT, CGNAT, VPN egress or office IP inherits the bypass of the username lock and the 50-per-15-min global cap. The attacker can also burn the owner's per-IP budget (5 per 15 min), which locks the owner out of their known address.
  - The trusted map is in memory. After a restart no address is trusted, so an attacker holding the global cap (about 10 rotating IPs × 5 failures per 15 min) keeps the owner out from every address until they stop.
- **Where:** `src/guard/rate-limit.ts:378-480` (`LoginGuard.isTrusted`/`recordSuccess`); `src/app/api/owner/login/route.ts:43-61`.
- **Fix:**
  - Issue a signed, HttpOnly, SameSite=Strict "known device" cookie (HMAC of a random id, 30 days) on successful login. Key the bypass on it, optionally combined with the IP.
  - Persist known-device ids (DB) so a restart does not reset them.
  - Document that `TRUST_PROXY=true` requires the app port to be reachable only through the proxy.
- **Severity:** Low. Brute force is still bounded at 5 per 15 min per key, and scrypt plus a strong passphrase makes guessing impractical. The realistic impact is owner-lockout DoS.
- **Resolution (round-2 fixer): FIXED.** IP-based trust is removed from `LoginGuard`. A successful sign-in sets `oasis_device` (`src/auth/device-token.ts`): HMAC-SHA256(SESSION_SECRET, "device:" + payload) over `{username, issuedAt, random 128-bit id}`, 30-day Max-Age, HttpOnly, SameSite=Strict, Secure in production, Path `/api/owner/login`. Only a verified cookie for the submitted username bypasses the username lock and global cap, and such a browser is throttled on its own `device:<id>` key instead of the IP (an attacker on the owner's IP cannot burn its budget). The token is stateless, so it survives restarts with no DB; rotating SESSION_SECRET invalidates all devices; a session token can't pass as a device token. Tests: `tests/unit/auth/device-token.test.ts`, `tests/unit/auth/routes.test.ts` (cookie attributes; the owner's IP without the cookie stays locked (429) while the cookie signs in from any IP; works after a simulated restart; rejected after a secret rotation; forged/tampered cookies ignored), `tests/unit/guard/rate-limit.test.ts`. `.env.example` now says `TRUST_PROXY=true` requires the app port to be reachable only through the proxy. SPEC §8 updated.

### R2-4 (Low, likely pre-existing): `OASIS_MAX_TURNS` allows one extra message
- **Repro:** start with `OASIS_MAX_TURNS=2` and send 4 messages in one conversation. Statuses: `200 200 200 429 session_limit`.
- **Cause:** the first message is checked with `conversationId` undefined, because the conversation is created after the rate-limit check. Turn 1 is never counted.
- **Where:** `src/app/api/chat/route.ts:106-107, 141-142`; `src/guard/rate-limit.ts:268-271`.
- **Fix:** consume a turn for the new conversation id right after `createConversation` (or seed the counter with 1). Add a unit test.
- **Resolution (round-2 fixer): FIXED.** The chat route calls `countFirstTurn(conversationId)` right after creating a conversation for a user message (not for `request_human`), so `OASIS_MAX_TURNS=N` accepts exactly N user messages. Test: `tests/unit/agent/route.test.ts` "R2-4" (N=2 → `200, 200, 429 session_limit`).

### R2-5 (Info): customer names typed into the "Talk to a person" note reach support
- **Evidence:** a note of "Please call Jane Roe at 415-555-0199, jane.roe@example.com" arrives as "Please call Jane Roe at [phone removed], [email removed]".
- The task's rule allows only the explicit `contactEmail`. Names cannot be redacted reliably from free text, and the customer deliberately wrote to support, so I consider this acceptable.
- Optional: a hint under the note field ("Don't include phone numbers or addresses").
- **Resolution (round-2 fixer): ACCEPTED — no change.** Agreed with the verifier: names can't be reliably redacted from free text, the customer is deliberately writing to support, and emails/phones are already removed.

### R2-6 (Low, cosmetic): support email wraps mid-address in the fallback card at 375
- **Evidence:** `shots/fallback-375.png` shows "support@volt-" / "supply.example.com".
- The VIS-7 fix (inline-block mailto with `overflow-wrap:anywhere`) was applied to the 429 card only. In the fallback reply the address is plain text inside the copy.
- **Where:** the fallback reply text from `src/agent/runner.ts` `fallbackText`, rendered by `ChatApp.tsx`.
- **Fix:** linkify emails in assistant text, or wrap them in the same `.mailto` treatment (no break inside).
- **Resolution (round-2 fixer): FIXED everywhere an email is shown.** A shared `.email` class (`display:inline-block; max-width:100%; overflow-wrap:anywhere`, `src/app/globals.css`) moves an address to the next line as one piece and only wraps an address wider than its card. `MessageText` turns every email in assistant text into a `mailto:` link with it (`splitEmails` in `src/ui-lib/format.ts`). This covers normal replies, fallback cards and the "Talk to a person" confirmation. It is also applied to the error/429 card link, the masked email on the review step, and emails in the owner transcript. Tests: `tests/unit/ui-lib.test.ts` (`splitEmails`), e2e `ui-chat.spec.ts` "fallback card: email never splits" at 375/768/1440 (one line box, inside the card, no horizontal scroll).

### R2-7 (Info): military APO/FPO addresses cannot check out
- AA/AE/AP with 340xx, 090xx and 962xx give 422 "Choose a US state or territory".
- For a demo of supply houses this is a reasonable exclusion, but the shipping policy says "any valid US ZIP".
- Either add AA/AE/AP (prefixes 340, 090–098, 962–966) with their zone, or have the agent and policy text say military addresses are not supported.
- **Resolution (round-2 fixer): FIXED (stated clearly).** The product shipping policy (`src/config/businesses.ts`, served by `get_policies`) now reads "…to any ZIP code in the 50 states, DC and US territories (…). Military APO/FPO/DPO addresses (AA, AE, AP) are not supported in this demo." It is found by the topics "APO", "military" and "shipping", and the `quote_cart` tool description points to it. The product form shows the hint "Military APO/FPO/DPO addresses aren't supported in this demo." under Street address. The dead "Military (APO/FPO)" select group was removed; state names now come from the shared `US_STATE_NAMES`. Tests: `tests/unit/domain/catalog.test.ts` "R2-7", and the e2e "R2-1/R2-7" checks the hint.

### R2-8 (Info): prefix 004 is treated as nonexistent
- The authoritative table lists 004 under NY (special-use ZIPs).
- `normalizeZip` rejects 000–004 (`src/contracts/zip.ts:110`). The risk is negligible, but `<= 3` would match the table exactly.
- **Resolution (round-2 fixer): FIXED.** `normalizeZip` rejects `<= 3` only, and the prefix table maps 004–005 to NY. 000–003 (incl. `00000`, `00399`) stay rejected. Tests: `tests/unit/contracts.test.ts` (00401/NY accepted, no warning; 00300/00399 rejected).

### R2-9 (Info / notes)
- The peer stamp does not cover `https.Server` (`next dev --experimental-https`): see the peer-address section above. A one-line note in the `peer-address.ts` header would help.
- Zero-width-joiner and VS16 stripping (pre-existing) splits emoji sequences in the text the model sees (👨‍👩‍👧 becomes 👨👩👧). Harmless.
- A fallback turn still shows "1 lookup: see how it answered" for a turn with no tool call (the trace counts the model step). Harmless.
- **Resolution (round-2 fixer): FIXED.**
  - Sanitize keeps U+200D only between an emoji (or skin-tone modifier) and a following emoji, and strips it everywhere else (`STRAY_ZWJ` in `src/guard/sanitize.ts`). So family and skin-tone profession sequences survive; ZWJ between letters, at the edges or doubled is removed.
  - "Lookups" now count tool calls only (`countLookups` / `traceLinkLabel`). A failed turn's link reads "See how it answered", and the header pill counts tool calls.
  - `peer-address.ts` has a header note that `https.Server` is not stamped.
  - Tests: `tests/unit/guard/sanitize.test.ts` "R2-9", `tests/unit/ui-lib.test.ts`, and the e2e fallback-card test. The VIS-1 e2e now expects "1 lookup" for a tool + model trace.

---

## Verdict

**All 68 round-1 fixes hold. No round-1 finding is still broken.** The three partials are deliberate, documented scope choices, and both "won't fix" justifications are acceptable for a production-ready demo.

All four gates pass. 15 real-browser checkout flows across 5 businesses × 3 widths pass. axe is clean at any impact level, and tap, focus and motion requirements are met.

**One material defect remains:**
- **R2-1 (Medium):** a regression introduced by the ADV-1/EDGE-1 fix. Real customers in about 137 cross-state ZIP areas are blocked at checkout unless they enter a false state.

Every other new finding is Low or Info:
- spam and abuse hardening: R2-2, R2-3
- an off-by-one cap: R2-4
- cosmetic and notes: R2-5 to R2-9

I recommend fixing R2-1 (make the check a soft warning, or add a multi-state ZIP allow-list) and R2-2 (per-IP escalation limiter) before calling the demo production-ready.
