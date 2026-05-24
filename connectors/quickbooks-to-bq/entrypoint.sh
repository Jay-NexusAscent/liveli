#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-quickbooks target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_QUICKBOOKS_CLIENT_ID:?Liveli Intuit OAuth client_id required (from Secret Manager)}"
: "${TAP_QUICKBOOKS_CLIENT_SECRET:?Liveli Intuit OAuth client_secret required (from Secret Manager)}"
: "${TAP_QUICKBOOKS_REFRESH_TOKEN:?Customer refresh_token required (minted via /api/auth/oauth/intuit)}"
: "${TAP_QUICKBOOKS_REALMID:?QuickBooks Company ID (realmId) required — captured from Intuit OAuth callback}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

# is_sandbox defaults to false at the meltano.yml level; the sync route
# always sets it explicitly via buildTapEnv. Surface its current value
# in the run log so it's clear which QB environment we're hitting.
export TAP_QUICKBOOKS_IS_SANDBOX="${TAP_QUICKBOOKS_IS_SANDBOX:-false}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: quickbooks (realmId $TAP_QUICKBOOKS_REALMID, sandbox=$TAP_QUICKBOOKS_IS_SANDBOX) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"
STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# See LIVELI-118.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-quickbooks target-bigquery --state-id "$STATE_ID"
