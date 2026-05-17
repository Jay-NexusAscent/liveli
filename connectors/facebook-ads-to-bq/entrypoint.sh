#!/usr/bin/env bash
set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_META_ADS_ACCESS_TOKEN:?Meta Marketing API access token required}"
: "${TAP_META_ADS_ACCOUNT_IDS:?Comma-separated Meta ad-account IDs required (act_xxxxxx)}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-US}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: meta-ads (accounts: $TAP_META_ADS_ACCOUNT_IDS) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-meta-ads target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
