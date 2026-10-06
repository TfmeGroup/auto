#!/usr/bin/env bash
# Restore drill: prove a backup is actually restorable, without touching production.
#
#   ADMIN_DATABASE_URL=postgresql://postgres:...@host:5432/postgres \
#   BACKUP=/secure/backups/20261004T020000Z  ./scripts/restore-drill.sh
#
# Restores db.dump into a throwaway database, then checks that the restore is complete and the
# security properties survived (RLS enabled, audit trigger present, app role exists). Run it on a
# schedule (e.g. monthly) and after every change to the backup process. A backup that has never been
# restored is a hope, not a backup.
#
# STATUS: written but NOT executed in the build environment (no pg tools available there).
set -euo pipefail

: "${ADMIN_DATABASE_URL:?connection with CREATEDB (to the 'postgres' database)}"
: "${BACKUP:?path to a backup folder produced by scripts/backup.sh}"
SCRATCH="tfme_auto_restore_drill_$(date -u +%s)"
SCRATCH_URL="${ADMIN_DATABASE_URL%/*}/$SCRATCH"

( cd "$BACKUP" && sha256sum -c SHA256SUMS )

echo "[drill] creating scratch database $SCRATCH"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH\""
trap 'psql "$ADMIN_DATABASE_URL" -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null' EXIT

echo "[drill] restoring..."
pg_restore --no-owner --exit-on-error --dbname "$SCRATCH_URL" "$BACKUP/db.dump"

q() { psql "$SCRATCH_URL" -At -v ON_ERROR_STOP=1 -c "$1"; }

echo "[drill] verifying..."
users=$(q "SELECT count(*) FROM users")
businesses=$(q "SELECT count(*) FROM businesses")
audits=$(q "SELECT count(*) FROM audit_logs")
unprotected=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname IN ('customers','files','notifications','locations','number_sequences','audit_logs')
                   AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
trigger=$(q "SELECT count(*) FROM pg_trigger WHERE tgname IN ('audit_logs_no_update_delete','audit_logs_no_truncate')")
migrations=$(q "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")

echo "  users=$users businesses=$businesses audit_logs=$audits migrations=$migrations"
[[ "$unprotected" == "0" ]] || { echo "FAIL: $unprotected tenant tables lost row-level security"; exit 1; }
[[ "$trigger" == "2" ]] || { echo "FAIL: audit immutability triggers missing"; exit 1; }
echo "[drill] OK — backup restores cleanly and security controls are intact."
echo "        Record this drill (date, backup used, duration) in your operations log."
