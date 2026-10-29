#!/bin/sh
# Oasis container entrypoint (Dockerfile ENTRYPOINT; also usable on any POSIX host).
#
#   1. apply Prisma migrations (creates the SQLite directory + file if missing)
#   2. seed demo data when the database has no businesses (OASIS_SEED_ON_BOOT=if-empty, default)
#      - always: wipe + reseed on every boot (ephemeral hosts, e.g. Render Free)
#      - never:  only migrate
#   3. exec `next start` on $PORT (default 3000), so the server receives SIGTERM directly.
#
# Extra arguments are passed to `next start`.
set -eu

cd "$(dirname "$0")/.."

NODE_BIN="${NODE_BIN:-node}"
TSX="node_modules/tsx/dist/cli.mjs"
NEXT="node_modules/next/dist/bin/next"
SEED_MODE="${OASIS_SEED_ON_BOOT:-if-empty}"
export DATABASE_URL="${DATABASE_URL:-file:./.data/oasis.db}"

log() { printf '[entrypoint] %s\n' "$*"; }

# Render sets RENDER_EXTERNAL_URL (https://<name>.onrender.com); use it when APP_URL is unset
# so CSRF origin checks and email links match the public URL.
if [ -z "${APP_URL:-}" ] && [ -n "${RENDER_EXTERNAL_URL:-}" ]; then
  export APP_URL="$RENDER_EXTERNAL_URL"
  log "APP_URL not set: using RENDER_EXTERNAL_URL (${APP_URL})"
fi

case "$SEED_MODE" in
  if-empty | always | never) ;;
  *)
    log "unknown OASIS_SEED_ON_BOOT='${SEED_MODE}' (use if-empty | always | never)" >&2
    exit 2
    ;;
esac

log "applying migrations (DATABASE_URL=${DATABASE_URL})"
"$NODE_BIN" "$TSX" scripts/db.ts setup

# Number of rows in "Business" (migrations have run, so the table exists). Prints "error"
# when the count cannot be read: never wipe data we could not inspect. SQLite only.
business_count() {
  "$NODE_BIN" -e '
    const url = process.env.DATABASE_URL || "";
    if (!url.startsWith("file:")) { process.stdout.write("unknown"); process.exit(0); }
    const file = url.slice(5).split("?")[0];
    try {
      const Database = require("better-sqlite3");
      const db = new Database(file, { readonly: true, fileMustExist: true });
      const row = db.prepare("SELECT COUNT(*) AS n FROM \"Business\"").get();
      db.close();
      process.stdout.write(String(row.n));
    } catch (err) {
      console.error("[entrypoint] could not count businesses:", err && err.message);
      process.stdout.write("error");
    }
  '
}

case "$SEED_MODE" in
  always)
    log "OASIS_SEED_ON_BOOT=always: reseeding demo data"
    "$NODE_BIN" "$TSX" prisma/seed/index.ts
    ;;
  never)
    log "OASIS_SEED_ON_BOOT=never: skipping seed"
    ;;
  if-empty)
    count="$(business_count)"
    if [ "$count" = "0" ]; then
      log "database is empty: seeding demo data"
      "$NODE_BIN" "$TSX" prisma/seed/index.ts
    elif [ "$count" = "error" ] || [ "$count" = "unknown" ]; then
      log "could not inspect the database (${count}): skipping seed; set OASIS_SEED_ON_BOOT=always to force"
    else
      log "database already has ${count} businesses: skipping seed"
    fi
    ;;
  *)
    log "unknown OASIS_SEED_ON_BOOT='${SEED_MODE}' (use if-empty | always | never)" >&2
    exit 2
    ;;
esac

PORT="${PORT:-3000}"
log "starting Next.js on 0.0.0.0:${PORT} (NODE_ENV=${NODE_ENV:-unset})"
exec "$NODE_BIN" "$NEXT" start -H 0.0.0.0 -p "$PORT" "$@"
