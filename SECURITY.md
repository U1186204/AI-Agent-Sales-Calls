# Security Policy

Oasis is a demo app: an AI sales and booking assistant for five fictional businesses. It
handles names, emails, phone numbers and addresses that visitors type into the checkout form,
so we take reports seriously even though it is not a production commerce system.

## Supported versions

| Version | Supported |
|---|---|
| `main` (latest commit) | Yes |
| 0.1.x | Yes, fixes land on `main` and in the next 0.1.x release |
| Older | No |

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

1. Use GitHub's private reporting: the repository's **Security** tab → **Report a
   vulnerability** (GitHub Security Advisories).
2. If that is unavailable, contact the maintainers privately through the contact listed on the
   repository profile and ask for a private channel. Don't put exploit details in the first
   message.

Please include the affected commit or version, steps to reproduce, the impact you expect, and
any proof-of-concept. Use fake data only. Never include real personal data.

What to expect:

- Acknowledgement within **3 business days**.
- An initial assessment within **10 business days**.
- A fix or mitigation plan, coordinated disclosure, and credit in `CHANGELOG.md` if you want it.

Good-faith research that follows this policy will not lead to legal action from the
maintainers. Test only against your own local or self-hosted instance, not someone else's
deployment.

## Scope

In scope:

- Prompt injection or jailbreaks that make the assistant leak its system prompt, act for a
  different business, invent prices or stock, or bypass checkout validation.
- Cross-business data access (the `businessId` isolation rule in `docs/SPEC.md` §4).
- Order/booking status lookup enumeration, or lookups that succeed without the matching email.
- PII exposure: plaintext PII in the database, logs, traces, the trace panel, notification
  outbox, or LLM requests (card numbers and SSNs typed into chat must be redacted first).
- Owner dashboard authentication or session bypass, CSRF, missing or weak security headers, CSP
  bypass, XSS.
- Bypassing rate limits or the per-session and daily LLM budget caps.
- Double-booking or overselling through races in checkout confirm.
- Secrets leaking into the client bundle, the build output or the Docker image.

Out of scope:

- The **demo secrets** shipped in `.env.example` (see below). Using them is a documented
  limitation, not a vulnerability.
- The **TEST-ONLY scripted LLM** (`OASIS_LLM_STUB=1`). It is ignored unless `APP_URL` is
  localhost.
- Denial of service through volume, and findings that need a compromised host or a malicious
  local administrator.
- Data loss on hosts with an ephemeral filesystem (Render Free reseeds on every boot by design).
- Vulnerabilities in third-party services (Anthropic, Resend, Twilio, Render). Report those to
  the vendor.
- `npm audit` findings in development-only tooling with no reachable path in the running app.

## Demo secrets warning

`.env.example` ships working **demo-only** values so the quick start runs with no setup:
`OASIS_ENCRYPTION_KEY`, `OASIS_HMAC_KEY`, `SESSION_SECRET`, and an `OWNER_PASSWORD_HASH` for
the published password `oasis-demo-2026`. **They are public.** Anyone can decrypt PII
encrypted with them, forge owner sessions, and log in to the dashboard.

Before any deployment that strangers can reach, or that stores real data:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # run once per key
npm run owner:hash -- "a long unique passphrase"
```

- Set new values for all three keys and the owner hash. The dashboard shows a warning banner
  while the demo password hash is in use.
- `render.yaml` generates fresh random keys automatically. Set `OWNER_PASSWORD_HASH` yourself.
- Never commit `.env`. It is in `.gitignore` and `.dockerignore`.
- Set a monthly spend limit in the Anthropic Console as a backstop to the in-app budget caps.

## How Oasis handles PII

- **Collection:** contact and address details are entered only in the inline checkout form,
  never typed into chat. Inputs are constrained client-side and re-validated server-side
  with Zod.
- **Chat redaction:** card numbers (Luhn-checked) and SSN-like values typed into chat are
  redacted before they reach the LLM or the database.
- **At rest:** PII columns are encrypted with AES-256-GCM (`OASIS_ENCRYPTION_KEY`). Email
  lookups use an HMAC-SHA256 hash (`OASIS_HMAC_KEY`), so the plaintext email is never indexed.
- **Logs and traces:** structured JSON logs and the transparency panel mask emails, phone
  numbers and card-like numbers.
- **Status lookups:** a lookup needs the reference and the matching email. Wrong pairs get a
  generic "not found" response, and lookups are rate-limited per IP.
- **Notifications:** with no provider keys, email and SMS are written to the local mock outbox
  (`.data/outbox/`), which holds PII in plaintext. Treat `.data/` as sensitive and never
  commit it.
- **Seed data:** the seed creates no customers, orders or bookings, so it contains no PII.
- **Payments:** v1 does not collect or charge card details. The `Payment` record is a
  placeholder for a future provider.
