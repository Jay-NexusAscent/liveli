#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-ga4 target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_GA4_OAUTH_CREDENTIALS_CLIENT_ID:?Liveli Google OAuth client_id required (from Secret Manager)}"
: "${TAP_GA4_OAUTH_CREDENTIALS_CLIENT_SECRET:?Liveli Google OAuth client_secret required (from Secret Manager)}"
: "${TAP_GA4_OAUTH_CREDENTIALS_REFRESH_TOKEN:?Customer refresh_token required (minted via /api/auth/oauth/google)}"
: "${TAP_GA4_PROPERTY_ID:?GA4 property_id required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: ga4 (property $TAP_GA4_PROPERTY_ID) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"
STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# See LIVELI-118.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-ga4 target-bigquery --state-id "$STATE_ID"
