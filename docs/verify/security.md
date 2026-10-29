# Security + authorization verification

Run date: 2026-10-05/06. Target: production build (`next start`, `.next` BUILD_ID `J51AWFU-vDGfJG4Qxbt4E`, fresh vs `src/`)
on port 3201. Env: `DATABASE_URL=file:.data/verify-security/oasis.db` (migrated + seeded the way
`tests/e2e/global-setup.ts` does), `OUTBOX_DIR=.data/verify-security/outbox`, `APP_URL=http://localhost:3201`,
`OASIS_LLM_STUB=1`. Every other value came from `oasis-node-app/.env` or the defaults in `src/config/env.ts`.
That means **the demo secrets were live** (`SESSION_SECRET`, encryption/HMAC keys and the owner hash are the values in `DEMO_SECRETS`).
Server stdout went to `.data/verify-security/server.log`.

Unless noted, the repro commands use `B=http://localhost:3201` and send `Origin: $B` plus `content-type: application/json`.
Each request carries a distinct `X-Forwarded-For` so the rate limiters stay out of the way (see SEC-2).

## Summary

| ID | Severity | Title |
|---|---|---|
| SEC-1 | high (critical if deployed as-is) | Production starts silently with the public demo secrets, so owner sessions can be forged and PII decrypted |
| SEC-2 | high | Every per-IP rate limit, owner-login brute-force throttle included, is bypassed by spoofing `X-Forwarded-For` (default `TRUST_PROXY=false`) |
| SEC-3 | medium | A checkout draft is a bearer token: anyone holding the draft id can review or confirm it with their own details, and the real customer's later confirm "succeeds" as a replay of the attacker's order |
| SEC-4 | medium | Owner sessions are stateless: a stolen cookie stays valid for up to 8 h after logout, and the token `exp` is not capped |
| SEC-5 | medium | No request-body size limit: multi-MB JSON bodies are fully read and parsed on every API route |
| SEC-6 | low | Free-text address fields accept CR/LF, so injected lines appear in email bodies |
| SEC-7 | low | The CSRF allow-list trusts client `Host` / `X-Forwarded-Host` even when `TRUST_PROXY=false` |
| SEC-8 | low | The double-submit CSRF token is not bound to the session |
| SEC-9 | low | `checkout_completed` chat event is accepted in a conversation that does not own the draft |
| SEC-10 | low | Chat `lookup_status` tool is not counted by the status-lookup limiter |
| SEC-11 | low | Ids are Prisma `cuid()` v1 (timestamp + counter + host fingerprint, about 41 random bits), and they act as bearer tokens for drafts and conversations |
| SEC-12 | low | `Notification.subject` stores the customer first name + last initial in plaintext |
| SEC-13 | low | `npm audit --omit=dev`: 4 high, all transitive through the `prisma` CLI (`mysql2`, `deepmerge-ts`) |

No critical defect exists in the code paths themselves. SEC-1 becomes critical in any deployment that keeps the demo secrets.

---

## Findings (defects)

### SEC-1 — Production accepts demo secrets silently (owner-session forgery, PII decryptable) — HIGH
- **Repro:**
  1. `next start` (NODE_ENV=production) with no secrets set, or with `.env` copied from `.env.example`.
  2. Forge a cookie with the public demo `SESSION_SECRET` from `src/config/env.ts:17` / `.env.example`:
     ```js
     const p = Buffer.from(JSON.stringify({u:"owner",exp:9999999999})).toString("base64url");
     const s = require("crypto").createHmac("sha256","dhknrHmQZAIJNjrk4cAMsJDi1yqKFm9TqxBTq8p7Eyw=").update(p).digest("base64url");
     // curl -b "oasis_owner=$p.$s" $B/api/owner/overview
     ```
  3. Result: `GET /api/owner/overview` returns 200 and `GET /owner` returns 200 (full dashboard). Exp 9999999999 is accepted.
     The same applies to the public `OASIS_ENCRYPTION_KEY`, which decrypts every `*Enc` column, and to `OASIS_HMAC_KEY`, which lets an attacker confirm a guessed email against `emailHash`.
  4. `parseEnv({NODE_ENV:"production", APP_URL:"https://shop.example.com"})` succeeds, and the derived flags are `demo={encryptionKey:true,hmacKey:true,sessionSecret:true,ownerPassword:true}`.
     Startup logs contain no warning (server.log has only the stub banner). The dashboard banner (`OwnerDashboard.tsx:681`) depends only on `demo.ownerPassword`.
     If an operator changes the password but keeps the demo `SESSION_SECRET`, no warning appears anywhere.
- **Expected:** When `NODE_ENV=production` and `APP_URL` is not localhost, the app refuses to start with any demo secret, or at minimum logs a loud error. The banner covers every demo secret.
- **Actual:** The app starts normally, admin sessions can be forged, and PII can be decrypted by anyone who has read the repo.
- **Suspected location:** `src/config/env.ts:139-163` (`parseEnv`); `src/instrumentation.ts` (has no demo-secret check); `src/components/owner/OwnerDashboard.tsx:~678`.
- **Fix:**
  - In `parseEnv`, throw when `NODE_ENV==="production" && !isLocalUrl(APP_URL) && Object.values(demo).some(Boolean)`. Allow an explicit `OASIS_ALLOW_DEMO_SECRETS=1` escape hatch for demo hosting, and log an error when it is used.
  - Log a `demo_secrets_in_use` warning from `instrumentation.ts`.
  - Show the dashboard banner when any `demo.*` flag is true.
- **Resolution (Fixer A, server):** Fixed in `src/config/env.ts` (`parseEnv` throws when NODE_ENV=production + non-localhost APP_URL + any demo secret, naming the variables; explicit `OASIS_ALLOW_DEMO_SECRETS=true` escape hatch for throwaway demos), `src/instrumentation.ts` + `src/instrumentation-node.ts` (validates env at start, logs and `process.exit(1)`; warns on localhost), `src/app/api/owner/overview/route.ts` (`demoCredentials` true for ANY demo secret + new `demoSecrets` list), `.env.example`, SPEC §8. Verified live: `next start` with APP_URL=https://shop.example.com exits 1 naming all four variables. Tests: `tests/unit/guard/injection.test.ts` › "refuses production with a public APP_URL…", "allows localhost … escape hatch"; `tests/unit/integration/api-routes.test.ts` › "overview reports every demo secret…".

### SEC-2 — Rate limits bypassable via spoofed `X-Forwarded-For` — HIGH
- **Repro:**
  ```bash
  # same spoofed IP → throttled after 5
  for i in $(seq 1 7); do curl -s -o /dev/null -w "%{http_code} " -X POST $B/api/owner/login -H "Origin: $B" -H "content-type: application/json" -H "X-Forwarded-For: 10.9.9.9" -d '{"username":"owner","password":"wrong"}'; done
  # → 401 401 401 401 401 429 429  (Retry-After: 180)
  # rotate the header → never throttled
  for i in $(seq 1 10); do curl ... -H "X-Forwarded-For: 172.16.0.$i" ...; done
  # → 401 ×10
  ```
  The same pattern holds for:
  - `/api/status`: fixed IP gives 10×200 then 429; rotating gives 15×200.
  - `/api/health` (API 60/min): fixed IP gives 68×200 then 32×429; rotating gives 100×200.
  - `X-Forwarded-For: 1.1.1.1, 172.17.0.$i`: the right-most entry is spoofable too.
  - Spoofing the owner's real IP lets an attacker lock the owner out of login (DoS).
- **Expected:** With `TRUST_PROXY=false`, the server ignores client-supplied forwarding headers. The login throttle also has an IP-independent component.
- **Actual:** Next.js passes the client's `X-Forwarded-For` through unchanged (it only fills the header when absent). `clientIp()` takes the right-most entry whatever `TRUST_PROXY` says. The code comment at `src/guard/rate-limit.ts:270-279` acknowledges this.
- **Suspected location:** `src/guard/rate-limit.ts:281-295` (`clientIp`); `src/app/api/owner/login/route.ts:22`.
- **Fix:**
  - When `!trust`, do not read `x-forwarded-for`. Use a value the client cannot set: for example, have `proxy.ts` overwrite a private header (`x-oasis-client-ip`) from a source it controls, or run behind a required reverse proxy.
  - Add an IP-independent global login limiter (for example 20 failures per 15 min across all IPs) and a per-username backoff.
  - Add a global status-lookup cap.
  - In production with `TRUST_PROXY=false`, log a startup warning that per-IP limits are best-effort.
- **Resolution (Fixer A, server):** Fixed in `src/guard/peer-address.ts` (new: Next 16 exposes no socket address to route handlers/proxy and only fills XFF when absent, so the server stamps a per-process-secret header `x-oasis-peer` from `socket.remoteAddress` on every request, deleting any client value) + `src/guard/rate-limit.ts` (`clientIp` ignores XFF/X-Real-IP unless TRUST_PROXY; falls back to a shared key with 20× buckets; new IP-independent `LoginGuard`: per-username exponential backoff 30 s→15 min cap that refused attempts cannot extend, global 50 failures/15 min, and known-good devices (successful sign-in in 30 days) bypass both so the owner cannot be locked out) + `src/app/api/owner/login/route.ts`. Verified live on :3301: rotating XFF → login `401×5, 429×3`; status `200×10, 429×2`. Tests: `tests/unit/guard/rate-limit.test.ts` › "clientIp (SEC-2)", "LoginGuard (SEC-2)"; `tests/unit/auth/routes.test.ts` › "SEC-2: rotating X-Forwarded-For does not bypass throttling", "SEC-2: a device that signed in before is not locked out".

### SEC-3 — Checkout draft is a bearer capability; a hijacked confirm is reported to the victim as success — MEDIUM
- **Repro:** run `scratchpad/idor.mjs` (logic below).
  1. The victim's chat creates draft `D`, conversation `C`.
  2. From another IP with no conversation, the attacker calls `GET /api/checkout/draft/D` → 200 (summary, quote, status, later `resultRef`).
  3. The attacker sends `POST /api/checkout/confirm {kind:"product", draftId:D, customer:{...attacker@evil.example...}}` → 200 `OAS-X8FA-V8W2`, `replayed:false`. Notifications go to the attacker's email.
  4. The victim then confirms with their own details → 200 `{ok:true, reference:"OAS-X8FA-V8W2", replayed:true}`. The UI shows success, but the order carries the attacker's name and address, and the victim gets no email.
  5. `GET /api/checkout/draft/D` now exposes `resultRef`.
- **Expected:** Review and confirm are bound to the browser session or conversation that created the draft. A replay is honoured only for the same submitter (same customer email hash or a client nonce). Any other submitter gets `already_completed` (409).
- **Actual:** Anyone who learns the draft id controls it. Exploitation needs the id: it is in the chat response only, but it is a cuid (see SEC-11) and can leak through logs, screenshots or shared links.
- **Suspected location:** `src/app/api/_lib/checkout.ts:16` (envelope has no conversation/session binding); `src/domain/checkout.ts` confirm replay path (returns the existing reference without comparing the submitter); `src/app/api/checkout/draft/[draftId]/route.ts:37` (`resultRef`).
- **Fix:**
  - Issue an unguessable per-draft secret, either 32 random bytes returned with the form block or an HttpOnly cookie scoped to the conversation, and require it on draft GET, review and confirm.
  - On replay, return the reference only when `hmacLookup(email)` matches the stored customer. Otherwise return 409 `already_completed`.
  - Use `crypto.randomBytes`-based ids for drafts.
- **Resolution (Fixer A, server):** Fixed in `src/contracts/checkout.ts` (`conversationId` required in CheckoutInput), `src/domain/checkout.ts` (prepare + replay require the draft's conversation; other conversations get the same `draft_not_found`, replays never reveal the reference), `src/domain/checkout-draft.ts` (`getCheckoutDraftForConversation`, `listDraftSlots(…, conversationId)`), `src/app/api/_lib/checkout.ts` + `src/app/api/checkout/draft/[draftId]/route.ts` + `…/slots/route.ts` (`?conversationId=` or `x-conversation-id` header, 404 otherwise). Test: `tests/unit/integration/api-routes.test.ts` › "SEC-3: a draft is bound to its conversation (GET, slots, review, confirm, replay)".

### SEC-4 — Stateless owner session survives logout; `exp` not bounded — MEDIUM
- **Repro:** Log in and save the `oasis_owner` cookie. Call `POST /api/owner/logout` with the CSRF token → 200 and the cookies are cleared. Then `curl -b "oasis_owner=<saved>" $B/api/owner/overview` → **200**.
  A forged or long-lived token with `exp:9999999999` is also accepted (see SEC-1).
- **Expected:** Logout invalidates the token server-side, and tokens with `exp > now + SESSION_TTL_SEC` are rejected.
- **Actual:** The token is valid until `exp` (8 h) and the far-future `exp` is accepted.
- **Suspected location:** `src/auth/session-token.ts:36-64` (`verifySession`); `src/app/api/owner/logout/route.ts`.
- **Fix:**
  - Add an `iat` and a random `sid` to the payload. Keep an in-process revocation set, or a `sessionVersion` that logout bumps (persisted in the DB or in env-derived state). Check it in `getOwnerSession`.
  - In `verifySession`, reject `exp - now > SESSION_TTL_SEC`.
  - Document the remaining risk if the app stays stateless.
- **Resolution (Fixer A, server):** Fixed in `src/auth/session-token.ts` (payload `{u, sid, iat, exp}`; verify rejects tokens without sid, lifetime > 8 h, or exp > now+8 h), `src/auth/session-store.ts` (new in-process allow-list of active sids; logout revokes; restart signs out — fail-closed, documented in SPEC §8), `src/auth/session.ts`, `src/proxy.ts`, `src/app/api/owner/logout/route.ts`. Tests: `tests/unit/auth/session.test.ts` › "SEC-4: caps exp…", "SEC-4: logout revokes…"; `tests/unit/auth/routes.test.ts` › "clears cookies and revokes the session server-side (SEC-4)".

### SEC-5 — No request-body size limit on API routes — MEDIUM
- **Repro:**
  - A 5 MB JSON body to `POST /api/status` (`{"reference":"OAS-ZZZZ-ZZZZ","email":"a@b.co","junk":"x"*5e6}`) → 200 after the full parse.
  - A 5 MB body to `/api/checkout/review` → 422.
  - A 1.1 MB chat message → 400, but only after the full read and parse.
  - Each body is buffered and `JSON.parse`d in full. With SEC-2, an attacker can send many in parallel (memory/CPU DoS).
  - Deeply nested JSON (100k `[`) is handled without a crash: 400.
- **Expected:** Bodies over a small cap (for example 64 KB for chat/status/login and 16 KB for checkout) are rejected with 413 before parsing.
- **Actual:** No cap. `request.json()` reads everything.
- **Suspected location:** `src/app/api/_lib/http.ts:39` (`readJson`); `src/app/api/chat/route.ts:42`; `src/app/api/owner/login/route.ts:34`.
- **Fix:** In `proxy.ts`/`guardApi`, reject `content-length` above the cap with 413. In a shared `readJson(request, maxBytes)`, stream `request.body` and abort past the cap (this covers chunked requests without `content-length`). Use it in every route.
- **Resolution (Fixer A, server):** Fixed in `src/guard/api.ts` (proxy rejects declared content-length > 64 KB with 413) and `src/app/api/_lib/http.ts` (`readBody` streams and aborts past the cap; used by chat, status, login, checkout). Verified live: 100 KB chat body → 413. Tests: `tests/unit/auth/routes.test.ts` › "SEC-5: rejects a declared body over 64 KB with 413", "SEC-5: oversized body → 413"; `tests/unit/agent/route.test.ts` › "SEC-5: a body over 64 KB…"; `tests/unit/integration/api-routes.test.ts` › "SEC-5: a chunked body over 64 KB is cut off with 413".

### SEC-6 — CR/LF accepted in single-line address fields — LOW
- **Repro:** Confirm a checkout with `address2: "Apt\r\nBcc: victim@evil.com"` → 200.
  The outbox email text contains `Ship to: …, Apt\nBcc: victim@evil.com, Springfield…`, so a fake line appears in the email body.
  Subjects are **not** affected: they use only `firstName` and last initial, which `NAME_RE` restricts to letters.
- **Expected:** `address1`, `address2` (and `city`, which is already regex-restricted) reject control characters and newlines. `instructions` may keep `\n` but strips other control characters.
- **Suspected location:** `src/contracts/customer.ts:125-130` (`address1`), `:106` (`optionalTrimmed` used for `address2`).
- **Fix:** Add `.regex(/^[^\p{Cc}]*$/u)` to `address1` and `address2`. For `instructions`, normalize CRLF and strip `[\p{Cc}--[\n\t]]`.
- **Resolution (Fixer A, server):** Fixed in `src/contracts/customer.ts` (shared client/server): address1/address2 reject CR/LF, C0/C1 controls and invisible/bidi characters; instructions strip them (newlines kept). Test: `tests/unit/contracts.test.ts` › "rejects control / bidi characters in %s", "strips control, bidi and tag characters from instructions".

### SEC-7 — CSRF allow-list derived from client `Host` / `X-Forwarded-Host` — LOW
- **Repro:**
  - `curl -X POST $B/api/status -H "Origin: https://evil.com" -H "X-Forwarded-Host: evil.com" -H "X-Forwarded-Proto: https" -d '{}'` → passes CSRF (400 from the handler).
  - `-H "Host: evil.com" -H "Origin: http://evil.com"` → also passes.
  - A browser cannot set these headers cross-site without a CORS preflight, and preflight gets 204 with no `Access-Control-Allow-*`. Practical exposure is therefore limited to DNS rebinding and misconfigured proxies.
- **Expected:** With `TRUST_PROXY=false`, ignore `X-Forwarded-Host`/`-Proto`. In production, prefer the `APP_URL` origin alone.
- **Suspected location:** `src/guard/csrf.ts:47-63` (`allowedOrigins`).
- **Fix:** Pass `trustProxy` into `allowedOrigins`. Use forwarded headers only when it is true. In production, the allow-list should be `{origin(APP_URL)}` only.
- **Resolution (Fixer A, server):** Fixed in `src/guard/csrf.ts` (`allowedOrigins` policy: APP_URL + loopback aliases; X-Forwarded-Host/-Proto only with TRUST_PROXY; Host header only outside production) and `src/guard/api.ts`. Test: `tests/unit/guard/csrf.test.ts` › "SEC-7: without TRUST_PROXY, X-Forwarded-Host is ignored; in production Host is too".

### SEC-8 — Double-submit token not bound to session — LOW
- **Repro:** Send a real session cookie with `oasis_csrf=AAAA…(28 chars)` and `x-csrf-token: AAAA…` to `POST /api/owner/logout` → 200. Any attacker-chosen value works if the attacker can plant a cookie (sibling subdomain or an HTTP MITM, since cookies are not `Secure` on localhost).
- **Mitigations in place:** `SameSite=Strict` and the Origin check (both verified).
- **Suspected location:** `src/guard/csrf.ts:113-120`.
- **Fix:** Make the token `HMAC(SESSION_SECRET, sessionToken)` (signed double-submit) and verify it against the session cookie. Name the cookie `__Host-oasis_csrf` when `Secure`.
- **Resolution (Fixer A, server):** Fixed in `src/auth/session-token.ts` (`csrfTokenForSession` = HMAC(SESSION_SECRET, "csrf:"+sid)), `src/auth/session.ts` (issued at login), `src/guard/csrf.ts` (`checkDoubleSubmit(req, isBound)`), `src/proxy.ts` (recomputes from the active session cookie). The cookie name is unchanged (`oasis_csrf`), so the client code is unaffected. Tests: `tests/unit/auth/routes.test.ts` › "requires the session-bound CSRF token for owner writes (SEC-8)"; `tests/unit/guard/csrf.test.ts` › "SEC-8: …"; `tests/unit/auth/session.test.ts` › cookies.

### SEC-9 — `checkout_completed` event accepted cross-conversation — LOW
- **Repro:** Conversation A posts `{event:{type:"checkout_completed", draftId:<draft of conversation C>, reference:<its ref>}}` → 200. The agent confirms the order in A. The trace says "the reference was checked against this business", not this conversation.
- **Impact:** The attacker's own chat and owner analytics show a wrong `outcome: "order"`. No data from C is disclosed beyond what the attacker supplied.
- **Suspected location:** `src/agent` event handling for `checkout_completed` (verification query).
- **Fix:** Require `draft.conversationId === conversationId` in addition to the business match.
- **Resolution (Fixer A, server):** Fixed in `src/agent/runner.ts` (`describeEvent` uses `getCheckoutDraftForConversation`) and `src/app/api/chat/route.ts` (checkout events without a conversation → 400). Test: `tests/unit/agent/hardening.test.ts` › "rejects a completed draft from another conversation of the same business"; `tests/unit/agent/route.test.ts` › "checkout events need their conversation (400)".

### SEC-10 — Chat `lookup_status` bypasses the status limiter — LOW
- **Evidence:** `checkStatusRateLimit` is called only in `src/app/api/status/route.ts:35`. The chat tool `lookup_status` (verified working with reference + email in chat) is limited only by chat 20/10 min per IP. One turn can make up to 6 tool rounds with a real LLM.
- **Impact:** Weakens SPEC §8 anti-enumeration. The search space (32^8 × email) keeps enumeration impractical.
- **Fix:** Call `checkStatusRateLimit(ip)` inside the `lookup_status` tool executor (pass the IP via the turn context) and return a `rate_limited` tool result.
- **Resolution (Fixer A, server):** Fixed in `src/agent/tools.ts` (`lookup_status` consumes `checkStatusRateLimit(ip, conversationId)` and returns `rate_limited`), `src/guard/rate-limit.ts` (per-conversation bucket), `src/agent/runner.ts` + chat route (pass the client address). Tests: `tests/unit/agent/hardening.test.ts` › "SEC-10: lookup_status counts against the status limiter per conversation"; `tests/unit/guard/rate-limit.test.ts` › "status limiter (SEC-10)".

### SEC-11 — Predictable-structure ids used as bearer tokens — LOW
- **Evidence:** Ids in one run were `cmuvy9t6r00004ooy8yo3gj7x` and `cmuvy9tc600024ooyiaoqu57j`. They share a timestamp prefix and the fingerprint `4ooy`, and the counter is sequential (`0000`, `0002`). Only 8 base36 random characters (about 41 bits) remain.
- **Impact:** Draft ids (SEC-3) and conversation ids are bearer tokens. Anyone with a conversation id can continue that chat (verified: 200 from another IP), and the LLM sees the history.
- **Fix:** Use `@default(uuid(7))` plus a separate random secret, or generate `randomBytes(16).toString("base64url")` in code for `CheckoutDraft.id` and `Conversation.id`.
- **Resolution (Fixer A, server):** Fixed in `src/guard/crypto.ts` (`randomId()` = 16 random bytes base64url), `src/domain/conversations.ts` and `src/domain/checkout-draft.ts` (explicit ids; no migration needed — the Prisma default is simply not used). Test: `tests/unit/agent/hardening.test.ts` › "SEC-11: conversations and drafts get 128-bit random ids".

### SEC-12 — Partial PII in plaintext `Notification.subject` — LOW
- **Evidence:** A full-table scan of the SQLite DB for the submitted name, email, phone and address found a single plaintext hit: `Notification.subject = "New order OAS-26RU-SB87 — Zelda Q. — $15.00"`. It is also returned by `GET /api/owner/notifications`, which is owner-only.
- **Fix:** Store the subject without the name (for example "New order OAS-…") or encrypt it. Alternatively, document it as accepted minimal PII.
- **Resolution (Fixer A, server):** Fixed in `src/notify/templates.ts`: the business email subject (the only subject stored in `Notification`) is now `New order OAS-… for <Business> — $total` with no customer name. Test: `tests/unit/notify/notify.test.ts` › "WF-5 + SEC-12: …".

### SEC-13 — `npm audit --omit=dev` — LOW
- **Result:** 4 high, 0 critical: `prisma` → `@prisma/config` → `deepmerge-ts` (stack exhaustion), and `prisma` → `mysql2` (auth downgrade, zlib bomb). All are in the Prisma CLI tooling path. `mysql2` is unused with SQLite and `deepmerge-ts` only merges local config.
- **Note:** `prisma` is listed in `devDependencies`, yet audit still reports it under `--omit=dev`; it may be pulled in as a peer.
- **Fix:** Track the Prisma upstream fix. Do not run `npm audit fix --force`: it downgrades to prisma 6. Re-audit when Prisma 7.x ships patched transitive dependencies.
- **Resolution (Fixer A, server):** Won't fix (documented): all four are transitive through the `prisma` CLI (`mysql2` unused with SQLite, `deepmerge-ts` only merges local config); `npm audit fix --force` would downgrade to Prisma 6, which SPEC §3 forbids. Re-audit when Prisma 7.x ships patched dependencies.

---

## Passed checks (with evidence)

**AuthN**
- The login throttle works per actual IP: the 6th attempt gets 429 with `Retry-After: 180`, and the correct password is also refused while throttled. Without `X-Forwarded-For`, it throttles on the socket IP.
- Timing: bad username averages 0.105 s / 0.109 s vs bad password 0.108 s / 0.090 s over 12 samples each, so there is no measurable difference (scrypt always runs; username is compared via SHA-256 + `timingSafeEqual`). Both give an identical 401 body.
- Login input is bounded (username ≤ 100, password ≤ 200).
- Token tampering (forge.mjs) gives 401 on the API and a 307 redirect to `/owner/login` on the page for each of: tampered payload, missing sig, `alg:none` JWT, empty-secret HMAC, padded sig, truncated sig, other username, string `exp`, `__proto__` payload, and expired.
- Cookie flags: `oasis_owner` is HttpOnly + SameSite=Strict + Path=/ + Max-Age=28800. `oasis_csrf` is SameSite=Strict and not HttpOnly (by design). `Secure` is off only because `APP_URL` is localhost (`secureCookies()`).
- Logout clears both cookies (Max-Age=0); the stateless caveat is SEC-4.
- Open redirect: `safeNext()` only allows `^/owner(/[A-Za-z0-9/_-]*)?$`. In the browser, `/owner/login?next=//evil.com` landed on `http://localhost:3201/owner` after login.
- All 7 `/api/owner/*` GET routes return 401 without a session and 200 with one. `?businessId=../../x` → 400. POST to GET-only routes → 405. `/owner` without a cookie → 307 to `/owner/login`.

**AuthZ**
- Status lookup returns an identical body and code (200 `found:false`) for a wrong email or a wrong reference. The email comparison is case-insensitive. Latency for found and not-found is similar (26–35 ms).
- The owner API exposes only masked customer data: name "Z. Quixotic-O'Brien", `toMasked`, and conversations as metadata only.

**CSRF**
- For all 6 POST routes (chat, review, confirm, status, owner/login, owner/logout):
  - no Origin → 403 `missing_origin`
  - `Origin: https://evil.com` → 403
  - `Origin: null` → 403
  - `Sec-Fetch-Site: cross-site` / `same-site` → 403
  - foreign Origin + `Sec-Fetch-Site: same-origin` → 403
  - same-origin → passes
  - owner logout without or with a wrong `x-csrf-token` → 403 `token_missing` / `token_mismatch`
- PUT/DELETE/PATCH cross-origin → 403; same-origin → 405.
- Path variants: `/api/chat/` and `/api//chat` give a 308 redirect (no handler runs). `/api/%63hat` → 403. `/API/chat` → 404.
- A cross-origin preflight gets no `Access-Control-Allow-*` (204, `allow: OPTIONS, POST`).

**Headers/CSP**
- Every page (`/`, `/chat/*`, `/status`, `/owner/login`, `/owner`, 404) gets a per-request nonce CSP: `script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`. The nonce differs per request.
- API responses get `default-src 'none'; frame-ancestors 'none'`.
- All routes send nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy and COOP. HSTS (`max-age=63072000; includeSubDomains`) is set in the production build.
- Playwright pass over all pages, chat, owner login, every dashboard tab and logout: **0 CSP violations, 0 page errors, 0 dialogs**. Hydration works with the nonce (login and tabs functional).
- The owner page HTML has no inline event handlers and no `<script>` without a nonce.

**XSS**
- `<img src=x onerror=…>`, `<script>`, `javascript:` and markdown-link payloads in chat render as text: no `<img>` injected and no `javascript:` links.
- Checkout payloads in `address1` and `instructions` are HTML-escaped in both email templates (`&lt;img…`).
- Address and instructions are never returned to the owner dashboard. There is no `dangerouslySetInnerHTML` in `src/`.

**Secrets/PII**
- `.next/static` (1.2 MB) contains no hits for: rules text, `OASIS-CANARY`, "Internal marker", `customer_message`, any demo key or hash, `oasis-demo-2026`, `process.env`, `DATABASE_URL`, `sk-ant`, Resend or Twilio key patterns. The only hits are the literal names `SESSION_SECRET` and `OWNER_PASSWORD_HASH` in the dashboard banner text.
- DB: `Customer.{firstName,lastName,email,phone,address}Enc`, `Order.instructionsEnc` and every `Message.contentEnc` are `v1:` AES-GCM envelopes. `emailHash` is an HMAC. The only plaintext PII is SEC-12.
- The server log (363 lines covering checkout, status, chat with email/phone/card, and IDOR tests) contains none of the submitted names, emails, phones, addresses or the password. It holds codes and ids only.
- Chat trace: `lookup_status` input email is masked (`z***@e***.org`), the card number is redacted before the LLM ("Removed: card number"), and the reply does not echo the email or phone.
- Confirm responses carry per-channel statuses only (no recipients).

**Rate limits** (fixed IP, all return 429 with `Retry-After`)
- status: 10 per 10 min
- checkout: 30 per 10 min
- chat: 20 per 10 min
- API: 60 per minute (token bucket)
- login: 5 per 15 min

**Input handling**
- Invalid UTF-8, null bytes and `\u0000` in a draftId are handled (200 / 422, no crash).
- Deep nesting returns 400 or 422.
- `__proto__` and `constructor.prototype` keys in chat, status, login and checkout cause no pollution (Zod strips unknown keys, and the server stayed healthy).
- Unknown event types → 400. A spoofed `checkout_completed` with an unknown draft → "couldn't verify that checkout".
- The `/api/health` probe is healthy after all of the above.

**Secrets handling**
- `.env.example` holds only demo or blank values; provider keys are blank.
- `.gitignore` covers `.env`, `.env.local`, `.env.*.local` and `.data/` (verified with `git check-ignore -v`). No `.env` or `.data` files are tracked.
- Neither `.env` contains an `sk-` Anthropic key.
- No password, secret, credential, pem or key files exist in the repo (outside `.venv` and `node_modules`).

**Stub guard**
- `OASIS_LLM_STUB=1` with `APP_URL=https://example.com` or `https://localhost.evil.com` gives `llmStubActive=false`, and `warnLlmStub` logs `llm_stub_ignored`.
- With localhost or 127.0.0.1 it is active, with a startup banner.

## Notes
- Owner session forgery (SEC-1) was demonstrated live because this verification instance ran the demo `SESSION_SECRET` in a production build. That is exactly the configuration `.env.example` produces.
- HSTS is decided at build time (`process.env.NODE_ENV` in `next.config.ts`), so it is also emitted over plain-http localhost. Browsers ignore HSTS over http, so this is harmless.
- `includeSubDomains` with no `preload` is fine.
- Paths that end in `.ext` skip `proxy.ts` (matcher), so they get no CSP, CSRF check or API rate limit. No current route has a dynamic segment that matches this pattern: a draft id with a dot fails the lookup. A future route like `/api/files/[name]` should keep it in mind.
- The 404 for `/favicon.ico` is served without a CSP for the same reason.
- `OASIS_LLM_STUB` safety depends on the operator's `APP_URL`. A deploy that leaves `APP_URL=http://localhost:3000` (the `.env.example` default) behind a public proxy would activate the stub publicly. Consider also requiring `NODE_ENV!=="production"`, or an explicit second flag.
- Mid-run, the harness reaped the background shell wrapper for my server because system memory was low. The Next process (PID 11832, started by me) kept serving and was used for the remaining light checks. I did not try the multi-tens-of-MB body test (SEC-5) because memory was short. PID 11832 was stopped at the end, and port 3201 is free.
- Artifacts: DB `.data/verify-security/oasis.db`, outbox `.data/verify-security/outbox/`, log `.data/verify-security/server.log`. Test scripts are in the session scratchpad (`forge.mjs`, `checkout.mjs`, `idor.mjs`, `inputs.mjs`, `browser.cjs`, `db.cjs`).
