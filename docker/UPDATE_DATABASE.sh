#!/bin/bash
# Update database schema for v9.0

echo "📊 Updating database schema..."

# Run migration script
docker compose exec -T postgres psql -U whatsapp -d whatsapp < ../database/migration_v9.sql

echo "✅ Database updated!"

