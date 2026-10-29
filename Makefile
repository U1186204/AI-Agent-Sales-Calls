# Oasis — thin, portable wrappers around the npm scripts in package.json.
#
# Works with GNU make 3.81+ on Linux, macOS (stock /usr/bin/make) and Git Bash on Windows.
# Recipes use POSIX sh only. npm itself is the source of truth: every target just calls
# `npm run <script>`, so `make` is optional — the npm commands work everywhere without it.
#
#   make setup                         first-time setup: npm ci, .env from .env.example, seed
#   make dev                           dev server on http://localhost:3000
#   make dev ARGS="-p 3205"            extra arguments are passed through to the npm script
#   make owner-hash PASS="a long passphrase"
#
# Targets use hyphens where the npm script uses a colon (test:e2e -> test-e2e).

SHELL := /bin/sh
.DEFAULT_GOAL := help
# Prerequisites (setup: install -> env -> seed) must run in order, even under `make -j`.
.NOTPARALLEL:

NPM ?= npm
# Extra arguments forwarded to the npm script (after `--`).
ARGS ?=
# Passphrase for `make owner-hash`.
PASS ?=
# Docker image tag for `make docker-build`.
IMAGE ?= oasis:local

# `npm run x -- <args>` only when ARGS is set.
FWD = $(if $(strip $(ARGS)),-- $(ARGS),)

.PHONY: help setup install env dev build start lint typecheck test test-coverage test-e2e \
	eval seed db-migrate db-reset owner-hash format format-check check ci \
	docker-build docker-up docker-down

help: ## List targets
	@echo "Oasis make targets (each wraps an npm script; ARGS=\"...\" is forwarded):"
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'

# --- setup --------------------------------------------------------------------------

setup: install env seed ## First-time setup: npm ci, create .env if missing, migrate + seed
	@echo "Setup complete. Run 'make dev' and open http://localhost:3000"

install: ## Install exact dependencies from package-lock.json (npm ci)
	$(NPM) ci

env: ## Create .env from .env.example if it does not exist (never overwrites)
	@if [ -f .env ]; then \
		echo ".env already exists; leaving it unchanged"; \
	else \
		cp .env.example .env && echo "Created .env from .env.example (demo values)"; \
	fi

# --- npm script mirrors --------------------------------------------------------------

dev: ## Start the Next.js dev server (npm run dev)
	$(NPM) run dev $(FWD)

build: ## Production build (npm run build)
	$(NPM) run build $(FWD)

start: ## Start the production server; run 'make build' first (npm start)
	$(NPM) run start $(FWD)

lint: ## ESLint (npm run lint)
	$(NPM) run lint $(FWD)

typecheck: ## TypeScript, no emit (npm run typecheck)
	$(NPM) run typecheck $(FWD)

test: ## Unit tests with Vitest (npm test)
	$(NPM) run test $(FWD)

test-coverage: ## Unit tests with V8 coverage -> coverage/ (npm run test:coverage)
	$(NPM) run test:coverage $(FWD)

test-e2e: ## Playwright e2e on a fresh production build (npm run test:e2e)
	$(NPM) run test:e2e $(FWD)

eval: ## Agent eval suite (npm run eval)
	$(NPM) run eval $(FWD)

seed: ## Apply migrations, then wipe + reload demo data (npm run seed)
	$(NPM) run seed $(FWD)

db-migrate: ## Apply migrations only (npm run db:migrate)
	$(NPM) run db:migrate $(FWD)

db-reset: ## Drop the SQLite DB, migrate, seed; stop the dev server first (npm run db:reset)
	$(NPM) run db:reset $(FWD)

owner-hash: ## Hash an owner password: make owner-hash PASS="a long passphrase"
	@if [ -z "$(PASS)" ]; then \
		echo 'Usage: make owner-hash PASS="a long passphrase"' >&2; exit 2; \
	fi
	@$(NPM) run --silent owner:hash -- "$(PASS)"

format: ## Prettier --write (npm run format)
	$(NPM) run format $(FWD)

format-check: ## Prettier --check (npm run format:check)
	$(NPM) run format:check $(FWD)

# --- aggregates -----------------------------------------------------------------------

check: lint typecheck test ## Fast local gate: lint + typecheck + unit tests

ci: lint typecheck test-coverage build test-e2e ## Everything CI runs, in CI order

# --- docker (needs Docker installed) --------------------------------------------------

docker-build: ## Build the production image
	docker build -t $(IMAGE) .

docker-up: env ## docker compose up --build (uses .env)
	docker compose up --build

docker-down: ## Stop the compose stack (the data volume is kept)
	docker compose down
