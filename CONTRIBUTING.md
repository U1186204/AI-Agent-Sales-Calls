# Contributing to Oasis

Thanks for helping. This guide covers local setup, the scripts, how changes flow into `main`,
and what every pull request needs. The product and architecture rules live in
[`docs/SPEC.md`](docs/SPEC.md), which is the source of truth. If your change makes code and the
spec disagree, update both in the same pull request.

## Prerequisites

- **Node.js 24** (see `.nvmrc`; `nvm use` or `fnm use` picks it up). `.npmrc` sets
  `engine-strict=true`, so older Node versions fail at install time.
- **npm 11** (bundled with Node 24). Install scripts run only for the packages approved in
  `package.json` → `allowScripts` (`better-sqlite3`, `prisma`, `@prisma/engines`, `esbuild`,
  `unrs-resolver`). If you add a dependency that needs an install script, add it there and say
  why in the PR.
- Git. On Windows, use **Git Bash**: every npm script is written to run unchanged in Git Bash,
  macOS and Linux.
- Optional: GNU make (the `Makefile` only wraps the npm scripts), Docker.

## First-time setup

```sh
npm install            # or: npm ci
cp .env.example .env   # demo values work locally; ANTHROPIC_API_KEY is optional
npm run seed           # creates .data/oasis.db, applies migrations, loads demo data
npm run dev            # http://localhost:3000
```

`make setup` does the first three steps (it never overwrites an existing `.env`).

Without an `ANTHROPIC_API_KEY`, the chat shows an "assistant not configured" message and the
booking form still works. Email and SMS go to the mock outbox (`.data/outbox/`) unless
Resend/Twilio keys are set.

## Scripts

| npm | make | What it does |
|---|---|---|
| `npm run dev` | `make dev` | Next.js dev server |
| `npm run build` | `make build` | Production build |
| `npm start` | `make start` | Serve the production build |
| `npm run lint` | `make lint` | ESLint (flat config) |
| `npm run typecheck` | `make typecheck` | `tsc --noEmit` |
| `npm test` | `make test` | Vitest unit + integration tests |
| `npm run test:coverage` | `make test-coverage` | Vitest with V8 coverage → `coverage/` |
| `npm run test:e2e` | `make test-e2e` | Playwright: builds, serves on port 3100 with its own DB and the scripted test LLM |
| `npm run eval` | `make eval` | Agent eval suite (`evals/`) |
| `npm run seed` | `make seed` | Migrate, then wipe and reload demo data |
| `npm run db:migrate` | `make db-migrate` | Apply migrations only |
| `npm run db:reset` | `make db-reset` | Drop the SQLite DB, migrate, seed (stop the dev server first) |
| `npm run owner:hash -- "pass"` | `make owner-hash PASS="pass"` | Print an owner password hash for `.env` |
| `npm run format` | `make format` | Prettier `--write` |
| `npm run format:check` | `make format-check` | Prettier `--check` |

Pass extra arguments with `--` (npm) or `ARGS="..."` (make), e.g. `npm run dev -- -p 3005`.

First-time e2e runs need a browser: `npx playwright install chromium`.

### Git Bash on Windows

- Use forward slashes and POSIX commands (`cp`, not `copy`).
- Don't add `rm -rf`, inline `VAR=x cmd`, or single-quoted globs to npm scripts: they break in
  cmd.exe. Put anything non-trivial in a Node script under `scripts/` and run it with `tsx`.
- `npm run db:reset` cannot delete the database while a dev server holds it open. Stop the
  server first.
- The repo uses LF line endings (`.gitattributes`, `.editorconfig`). Keep `core.autocrlf`
  from converting shell scripts, or `scripts/docker-entrypoint.sh` fails inside Linux.

## Branches and pull requests

1. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
2. Keep each PR to one concern. Link the SPEC section or acceptance test (`AT-xx`) it touches.
3. Before pushing, run the local gate: `npm run lint && npm run typecheck && npm test`
   (`make check`). Run `npm run test:e2e` when you touch UI, API routes, checkout or the agent.
4. Open the PR against `main`. CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests
   with coverage, a production build, and Playwright e2e. All of it must pass. CI needs no
   secrets and never calls paid APIs.
5. Get one review from the module owner (below), then squash-merge.

## Code ownership

Each directory has one owner and a public `index.ts`. Other modules import only that index.
From [SPEC §4](docs/SPEC.md#4-architecture-and-module-boundaries):

| Module | Path | Owns | Must not |
|---|---|---|---|
| Contracts | `src/contracts/` | Zod schemas and inferred types shared by client and server | Import anything but `zod` |
| Config | `src/config/` | `pricing.ts` (all prices, tax, shipping, surcharges), `businesses.ts`, `env.ts` (validated env) | Touch the DB |
| Domain | `src/domain/` | Catalog, pricing, tax, shipping, inventory, availability, checkout, status, escalation | Call the LLM; read `process.env` directly |
| Agent | `src/agent/` | System prompt, tools, executor, runner loop, trace builder | Write to the DB except through domain functions |
| Guard | `src/guard/` | Rate limits, budgets, PII redaction, crypto, CSRF, logger | Depend on agent or domain |
| Notify | `src/notify/` | Email and SMS providers, mock outbox, templates, notification log | Depend on agent |
| Auth | `src/auth/` | Owner login, scrypt verify, signed session cookie | Store passwords anywhere but env |
| UI | `src/app/`, `src/components/` | Pages, thin route handlers, components, styles | Hold business logic |
| Data | `prisma/` | Schema, migrations, seed | Hold pricing (the seed reads `src/config/pricing.ts`) |
| Tests | `tests/unit`, `tests/e2e`, `evals/` | Test code | Ship in the app bundle |

Two rules reviewers always check:

- **Data isolation:** `businessId` comes from the server-side conversation record, never from
  model output or the request body. Every domain query takes `businessId` first.
- **Env access:** only `src/config/env.ts` reads `process.env` for app settings. A new variable
  needs a default (or optional) there, a line in `.env.example`, and a row in SPEC §8 when it is
  a guardrail.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <imperative summary, max 72 chars>

Why the change was needed and anything a reviewer should know.
```

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`, `build`.
- Scope is the module: `agent`, `domain`, `guard`, `notify`, `auth`, `ui`, `prisma`, `config`, `ci`.
- Example: `fix(domain): recheck slot availability inside the confirm transaction`.
- User-visible changes also get a line under `## [Unreleased]` in `CHANGELOG.md`.

## Tests are required

- **Every behaviour change ships with a test.** Domain, guard, notify, auth and agent logic get
  Vitest tests in `tests/unit/`. Unit tests use a temporary SQLite database per file
  (`setPrismaOverride`) and never touch `.data/oasis.db`.
- UI flows and API routes get Playwright specs in `tests/e2e/`: `ui-*` specs mock the API,
  `fullstack-*` specs run against the real server with the scripted LLM (`OASIS_LLM_STUB=1`).
- Agent prompt or tool changes: run `npm run eval` and paste the summary in the PR.
- Don't lower coverage. CI posts the coverage summary on every run.
- Bug fixes start with a failing test that reproduces the bug.

## Database changes

1. Edit `prisma/schema.prisma`, keeping it portable to Postgres: integer cents, string status
   columns validated by Zod, UTC timestamps.
2. `npx prisma migrate dev --name <change>` creates a migration. Commit it.
3. Update the seed if needed, then run `npm run db:reset`.

## Security

Don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md). Never commit
`.env`, real customer data, API keys or screenshots that show real PII.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
