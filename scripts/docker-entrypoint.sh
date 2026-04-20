#!/bin/sh
set -e
mkdir -p /data
echo "Seeding /data/spotlight.db shows from scripts/seed.sql (--force; watchlist preserved)"
DB_PATH=/data/spotlight.db node scripts/seed-db.mjs --force
exec "$@"
