#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-google-ads target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_GOOGLE_ADS_DEVELOPER_TOKEN:?Google Ads developer token required}"
: "${TAP_GOOGLE_ADS_CLIENT_ID:?OAuth client ID required}"
: "${TAP_GOOGLE_ADS_CLIENT_SECRET:?OAuth client secret required}"
: "${TAP_GOOGLE_ADS_REFRESH_TOKEN:?OAuth refresh token required}"
: "${TAP_GOOGLE_ADS_CUSTOMER_IDS:?Comma-separated customer IDs required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: google-ads (customers: $TAP_GOOGLE_ADS_CUSTOMER_IDS) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-google-ads target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
