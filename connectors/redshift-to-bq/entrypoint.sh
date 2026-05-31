#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-postgres target-bigquery`
# against an Amazon Redshift cluster (Postgres-wire-compatible).
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID is required}"
: "${CONNECTOR_ID:?CONNECTOR_ID is required}"
: "${TAP_POSTGRES_HOST:?redshift host required}"
: "${TAP_POSTGRES_USER:?redshift user required}"
: "${TAP_POSTGRES_PASSWORD:?redshift password required}"
: "${TAP_POSTGRES_DATABASE:?redshift database required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

# Redshift's default endpoint port is 5439 (not Postgres' 5432).
export TAP_POSTGRES_PORT="${TAP_POSTGRES_PORT:-5439}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: $TAP_POSTGRES_HOST/$TAP_POSTGRES_DATABASE (Redshift) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
# Same as the other DB connectors: bookmarks live in a residency-scoped
# GCS bucket so incremental state survives the ephemeral container.
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# Redshift PKs are informational only (not enforced), so the loader
# runs in `overwrite: true` mode and streams stay FULL_TABLE. DO NOT
# re-enable LIVELI_REPLICATION_CONFIG here without first moving the
# loader to upsert AND building reliable PK gating — the overwrite +
# INCREMENTAL combination wiped data in LIVELI-111.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-postgres target-bigquery --state-id "$STATE_ID"
