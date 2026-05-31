#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-oracle target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_ORACLE_HOST:?Oracle host required}"
: "${TAP_ORACLE_USER:?Oracle user required}"
: "${TAP_ORACLE_PASSWORD:?Oracle password required}"
: "${TAP_ORACLE_SERVICE_NAME:?Oracle service_name required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TAP_ORACLE_PORT="${TAP_ORACLE_PORT:-1521}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: $TAP_ORACLE_HOST/$TAP_ORACLE_SERVICE_NAME (Oracle) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# overwrite + FULL_TABLE, raw-DB contract.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-oracle target-bigquery --state-id "$STATE_ID"
