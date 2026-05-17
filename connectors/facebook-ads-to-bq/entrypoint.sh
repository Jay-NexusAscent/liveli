#!/usr/bin/env bash
set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_FACEBOOK_ACCESS_TOKEN:?Meta Marketing API access token required}"
: "${TAP_FACEBOOK_ACCOUNT_ID:?Meta ad-account ID required (act_xxxxxx)}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-US}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: facebook ($TAP_FACEBOOK_ACCOUNT_ID) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-facebook target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
