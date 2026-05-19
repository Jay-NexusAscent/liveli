#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-salesforce target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_SALESFORCE_CLIENT_ID:?Salesforce Connected App client_id required}"
: "${TAP_SALESFORCE_CLIENT_SECRET:?Salesforce Connected App client_secret required}"
: "${TAP_SALESFORCE_REFRESH_TOKEN:?Salesforce OAuth refresh_token required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

# Default to production org. Customers on sandboxes set DOMAIN=test
# via the connect wizard.
export TAP_SALESFORCE_DOMAIN="${TAP_SALESFORCE_DOMAIN:-login}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: salesforce ($TAP_SALESFORCE_DOMAIN.salesforce.com) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-salesforce target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
