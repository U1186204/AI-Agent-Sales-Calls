# Free-tier research for Oasis

Researched 2026-10-05 from official pricing/docs pages (third-party sources flagged). Prices in USD.
Re-check before publishing: free tiers change often.

## 1. Anthropic API

| Item | Value | What it means for Oasis | Source |
|---|---|---|---|
| Haiku 4.5 ID | `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`) | Default chat model. Both IDs valid. 200K context, 64K max output. Retirement "not sooner than Oct 15, 2026", so keep the model ID in config and be ready to switch to Sonnet 5.5 | https://platform.claude.com/docs/en/about-claude/models/overview |
| Sonnet 5.5 ID | `claude-sonnet-5-5` (dateless, a pinned snapshot) | Optional higher-quality setting. 1M context. Adaptive thinking is on by default, which adds billed output tokens; `thinking: {type:"disabled"}` returns 400 (use `between_tools` or low effort) | same |
| Opus 5.5 ID | `claude-opus-5-5` | Too expensive for a free demo. Thinking can't be disabled | same |
| Haiku 4.5 price | $1 in / $5 out per MTok | Cheapest current model | https://platform.claude.com/docs/en/about-claude/pricing |
| Sonnet 5.5 price | $2 in / $10 out per MTok | 2x Haiku | same |
| Opus 5.5 price | $4 in / $20 out per MTok | 4x Haiku | same |
| Prompt caching | 5-min write 1.25x, 1-h write 2x, read 0.1x (Haiku $0.10/MTok read) | Cache the system prompt, tools and history: it pays off after one read | same |
| Min cacheable prefix | Haiku 4.5: **4,096 tokens**; Sonnet 5.5/Opus 5.5: 512 | A short Oasis system prompt + tools (~3K tokens) **will silently not cache on Haiku**. Either accept no caching or let the growing history cross 4,096 tokens (top-level auto `cache_control`) | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Tool-use overhead | +496 system tokens (Haiku, `auto`), +286 (Sonnet 5.5) plus tool schemas | Keep tool descriptions short. Note: forced `tool_choice` any/tool is a 400 on Sonnet/Opus 5.5 | pricing page |
| Free credits | "New users receive a small amount of free credits" (amount not stated) | Enough for development only; a card is needed for a public demo | pricing page FAQ |
| Rate limits (Start tier) | Haiku 4.5 and Sonnet 5.5: 1,000 RPM, 2M ITPM, 400K OTPM; cached reads don't count toward ITPM | Far above demo needs. New orgs may start in a lower "Evaluation" tier | https://platform.claude.com/docs/en/api/rate-limits |
| Spend cap | Start tier: $500/month cap; you can set a lower org/workspace spend limit in the Console | **Set a Console spend limit (e.g. $10/month)** as the backstop to the app-level caps | same |

## 2. Email

| Service | Limit | What it means for Oasis | Source |
|---|---|---|---|
| Resend Free | 100 emails/day, 3,000/month, 30-day log retention, domains: 3 listed on the pricing page | More than enough for booking confirmations | https://resend.com/pricing |
| Resend sandbox sender | `onboarding@resend.dev` delivers **only to the Resend account owner's email** (403 otherwise) | Fine for demos to yourself. Real recipients need a domain verified with DNS records (SPF/DKIM) | https://resend.com/docs/knowledge-base/403-error-resend-dev-domain |
| Resend transport | HTTPS API (SDK `resend` v6.32) | Works on hosts that block SMTP ports (Render Free) | npm |
| Nodemailer + Gmail SMTP | ~500 recipients/day for a personal Gmail; needs 2FA + App Password | Local/dev alternative. **Blocked on Render Free** (outbound 25/465/587 closed) | https://support.google.com/a/answer/166852 |
| Nodemailer + Ethereal | Fake SMTP inbox, never delivers; preview URL per message | Ideal default for dev/tests/CI: zero signup, no risk of real sends | https://ethereal.email |

## 3. SMS (Twilio)

| Item | Value | What it means for Oasis | Source |
|---|---|---|---|
| Trial allowance | Trials now give product-specific free units (e.g. 100 SMS) and expire after 30 days. Third-party 2026 reports still cite $15 credit | Enough for a demo, but it doesn't last | https://www.twilio.com/docs/usage/trials |
| Recipients | Only **verified** numbers, max 5 per trial account; the signup number is auto-verified; SMS limited to the signup country | Only the owner/testers can receive SMS. Public visitors can't | same |
| Message prefix | Trial SMS are prefixed "Sent from your Twilio trial account - " | Expected in demo screenshots | https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account |
| US A2P 10DLC | All 10DLC traffic to the US must be registered; **trial accounts cannot register** (paid account; ~7 business days). Toll-free numbers need Toll-Free Verification | Real US SMS costs money plus registration. Treat SMS as optional | https://www.twilio.com/docs/messaging/compliance/a2p-10dlc |

## 4. Hosting (Next.js + SQLite)

| Host | Free offer | SQLite persistence | Sleep / cold start | Source |
|---|---|---|---|---|
| Render Free web service | 750 instance-hours/month, Docker or Node | **Ephemeral FS**: wiped on every deploy/restart; no disks on free | Spins down after 15 min idle, ~1 min cold start. Outbound SMTP blocked. Free Postgres expires after 30 days (1 GB) | https://render.com/docs/free |
| Koyeb Free | 1 instance/org: 512 MB RAM, 0.1 vCPU, 2 GB SSD; Frankfurt or Washington | Ephemeral; **no volumes on free** | Scales to zero after 1 h idle | https://www.koyeb.com/docs/reference/instances |
| Railway | $5 one-time trial (30 days), then $1/month credit; 0.5 GB volume on free | Volume persists, but $1/month rarely covers an always-on Next.js app (est. 256 MB RAM ≈ $2.5/mo) | Optional serverless sleep | https://docs.railway.com/reference/pricing/free-trial |
| Fly.io | **No free tier** for new orgs: trial = 2 machine-hours or 7 days. From $2.19/mo (256 MB) + $0.15/GB-mo volume | Volumes persist (best SQLite fit if ~$2.50/mo is OK) | Auto stop/start available | https://docs.fly.io/about/pricing |
| Vercel Hobby | 1M invocations, 4 active-CPU-hrs, 100 GB transfer; **non-commercial only** | **Not viable**: read-only FS, `/tmp` (500 MB) ephemeral per instance | Serverless | https://vercel.com/kb/guide/is-sqlite-supported-in-vercel , https://vercel.com/docs/plans/hobby |

## 5. Free Postgres (migration path)

| Service | Free limits | What it means for Oasis | Source |
|---|---|---|---|
| Neon Free | Permanent, no card; 1 GB storage/project (20 GB/account), 100 CU-hours/project/month, scale-to-zero after 5 min (~sub-second wake), 10 branches | **Recommended** persistence path. Works with Prisma via `DATABASE_URL`; pairs with Render/Koyeb/Vercel | https://neon.com/pricing |
| Supabase Free | 500 MB DB, 2 active projects, **paused after 1 week of inactivity**, 5 GB egress | OK, but the pause after inactivity hurts a rarely visited demo | https://supabase.com/pricing |
| Render Postgres Free | 1 GB, **expires 30 days after creation** | Avoid for anything long-lived | https://render.com/docs/free |

## 6. GitHub Actions

| Item | Value | What it means for Oasis | Source |
|---|---|---|---|
| Public repos | Free on standard GitHub-hosted runners | Unlimited CI if the repo is public | https://docs.github.com/en/billing/concepts/product-billing/github-actions |
| Private repos (GitHub Free) | 2,000 min/month; 500 MB artifact/package storage | Lint+typecheck+Vitest+Playwright(Chromium) ≈ 5–8 min/run → ~250+ runs/month. Use Linux only (Windows ≈1.7x, macOS ≈10x cost) and upload Playwright traces only on failure | same |

## 7. Runtime and library versions (checked 2026-10-05 via nodejs.org/dist and the npm registry)

| Package | Version | Notes |
|---|---|---|
| Node.js | **24.x "Krypton" Active LTS** (24.21.0); 22.x "Jod" Maintenance LTS | Node 26 (26.10.0) is still "Current"; it isn't marked LTS in dist/index.json yet (expected ~late Oct 2026). Use `node:24-slim` and `engines: ">=22"` |
| Next.js | 16.x (latest 16.3.8) | App Router |
| Prisma | **7.x stable (7.10.0)**; npm `latest` tag points to 8.0.0-rc.20 | Pin `^7.10.0` explicitly, or `npm i prisma` installs an RC. Prisma 7 uses the `prisma.config.ts` + driver-adapter setup (SQLite: `@prisma/adapter-better-sqlite3`); check the Prisma 7 docs at scaffold time |
| Playwright | 1.63.0 | |
| Vitest | 5.0.3 | |
| @anthropic-ai/sdk | 0.131.0 | |
| resend / nodemailer / twilio | 6.32.0 / 10.0.15 / 6.1.2 | |

## Cost model: typical 12-turn conversation

Assumptions: system prompt ~1,000 tokens + 5–6 tool schemas ~1,500 + tool system prompt ~500 = ~3,000 fixed input tokens.
12 user turns, 4 of which trigger one tool round-trip, which gives **16 API calls**. History grows ~250–400 tokens/turn (≈2,000 avg).
Input ≈ 16 × 5,000 = **80K tokens**. Output ≈ **3K tokens** (short sales replies + tool_use JSON).

| Model | No caching | With caching (history > min prefix, 5-min TTL) |
|---|---|---|
| Haiku 4.5 | 80K×$1 + 3K×$5 = **$0.095** | ≈ **$0.04** (≈90% of input as $0.10/MTok reads + incremental 1.25x writes) |
| Sonnet 5.5 (+~3K thinking output) | 80K×$2 + 6K×$10 = **$0.22** | ≈ **$0.10** |
| Opus 5.5 | ≈ **$0.40+** | ≈ $0.15+ |

Rule of thumb: **~1 cent per Haiku turn without caching**, under half a cent with caching.

## Recommendations

**Chosen services**
- **LLM:** Anthropic API, default `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` (alias `claude-haiku-4-5` also works); allow override to `claude-sonnet-5-5`. `max_tokens` 1024, top-level automatic `cache_control`, max 20 turns and max 4 tool round-trips per user message.
- **Email:** provider switch `EMAIL_PROVIDER=console|ethereal|resend|smtp`. Default `console` (log only) for dev and CI, `ethereal` for realistic local previews, `resend` (HTTP API) in the deployed demo. Use `onboarding@resend.dev` until a domain is verified, which means emails go only to the account owner.
- **SMS:** `SMS_PROVIDER=console|twilio`, default `console`. Twilio trial is optional: verified numbers only (max 5), trial prefix, no US 10DLC registration on trial. Document this as a limitation and don't make SMS required.
- **CI:** GitHub Actions on ubuntu-latest, public repo (free). Playwright Chromium only, cache browsers, mock the Anthropic client in E2E so **CI never spends API money**.

**Hosting for the README walkthrough: Render Free (Docker web service)**
- Free, no card, Docker-native, and it supports `docker-compose`-style env setup.
- SQLite is **ephemeral** there: the container runs `prisma migrate deploy && prisma db seed` on boot, and the README states plainly that demo data resets on every deploy or restart and after the 15-minute idle spin-down.
- The first request after idle takes about 1 minute. Use the Resend HTTP API, because SMTP is blocked.
- Persistence upgrade path: switch the Prisma provider to PostgreSQL with **Neon Free** (permanent, no card). Avoid Render Free Postgres, which expires after 30 days.
- Alternatives:
  - Fly.io (~$2.50/mo) if persistent SQLite on a volume is required.
  - Koyeb Free behaves like Render (ephemeral) but sleeps after 1 h instead of 15 min.
  - Vercel only with Neon, never with SQLite.

**Default budget caps (enforced in app, tracked from `response.usage`)**

| Cap | Default | Rationale |
|---|---|---|
| `SESSION_BUDGET_USD` | **$0.25** | ≈2.5x a typical Haiku 12-turn chat without caching (~25 turns of headroom) |
| `DAILY_BUDGET_USD` | **$2.00** | ≈20 full Haiku conversations/day (~$60/month worst case) |
| Console org spend limit | **$10/month** | Hard backstop if app accounting fails |
| Per-IP rate limit | 20 messages / 10 min | Stops scripted abuse from draining the daily cap |

When a cap is hit, return a friendly "demo limit reached" message and fall back to the booking form, which works without the LLM.
