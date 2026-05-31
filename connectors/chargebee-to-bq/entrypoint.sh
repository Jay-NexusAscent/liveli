#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-chargebee target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_CHARGEBEE_API_KEY:?Chargebee API key required}"
: "${TAP_CHARGEBEE_SITE:?Chargebee site name required (the <site> in <site>.chargebee.com)}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TAP_CHARGEBEE_PRODUCT_CATALOG="${TAP_CHARGEBEE_PRODUCT_CATALOG:-2.0}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: $TAP_CHARGEBEE_SITE (chargebee, catalog $TAP_CHARGEBEE_PRODUCT_CATALOG) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# Dynamic per-stream config is postgres-only; this entrypoint stays static.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-chargebee target-bigquery --state-id "$STATE_ID"
