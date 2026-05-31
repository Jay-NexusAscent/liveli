#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-mongodb target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_MONGODB_MONGODB_CONNECTION_STRING:?MongoDB connection string required}"
: "${TAP_MONGODB_DATABASE:?MongoDB database required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: mongodb/$TAP_MONGODB_DATABASE → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# overwrite + FULL_TABLE, raw-DB contract. DO NOT re-enable
# LIVELI_REPLICATION_CONFIG without flipping the loader to upsert first.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-mongodb target-bigquery --state-id "$STATE_ID"
