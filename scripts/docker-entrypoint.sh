#!/bin/sh
set -e
mkdir -p /data
if [ ! -f /data/spotlight.db ]; then
  echo "No database at /data/spotlight.db — seeding from scripts/seed.sql"
  DB_PATH=/data/spotlight.db node scripts/seed-db.mjs
fi
exec "$@"
