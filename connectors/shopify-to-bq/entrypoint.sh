#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-shopify target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_SHOPIFY_STORE:?Shopify store handle required (xxx.myshopify.com)}"
: "${TAP_SHOPIFY_ADMIN_API_KEY:?Shopify Admin API access token required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: shopify($TAP_SHOPIFY_STORE) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-shopify target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
