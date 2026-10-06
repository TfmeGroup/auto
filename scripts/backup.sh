#!/usr/bin/env bash
# Logical backup of the TFME Auto database + file storage.
#
#   MIGRATE_DATABASE_URL=postgresql://... BACKUP_DIR=/secure/backups ./scripts/backup.sh
#
# Produces <BACKUP_DIR>/<timestamp>/{db.dump,files.tar.gz,SHA256SUMS}. Run it from cron / a scheduled job,
# ship the folder off-host to encrypted storage, and prune by your retention policy (docs/OPERATIONS.md).
# A managed Postgres' point-in-time recovery is the primary database safety net; this script is the
# portable, host-independent second layer.
#
# STATUS: written but NOT executed in the build environment (no pg_dump available there).
# Run scripts/restore-drill.sh against a real backup before relying on it.
set -euo pipefail

: "${MIGRATE_DATABASE_URL:?set MIGRATE_DATABASE_URL (owner connection)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STORAGE_DIR="${STORAGE_LOCAL_DIR:-}"   # only for the local storage driver; S3 buckets use bucket versioning/replication
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/$STAMP"
umask 077
mkdir -p "$OUT"

echo "[backup] dumping database..."
pg_dump --format=custom --no-owner --no-privileges --file "$OUT/db.dump" "$MIGRATE_DATABASE_URL"

if [[ -n "$STORAGE_DIR" && -d "$STORAGE_DIR" ]]; then
  echo "[backup] archiving local file storage..."
  tar -czf "$OUT/files.tar.gz" -C "$STORAGE_DIR" .
fi

( cd "$OUT" && sha256sum * > SHA256SUMS )
echo "[backup] done: $OUT"
