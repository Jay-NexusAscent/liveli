#!/usr/bin/env bash
set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_STRIPE_CLIENT_SECRET:?Stripe secret key required (sk_live_... or sk_test_...)}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TAP_STRIPE_START_DATE="${TAP_STRIPE_START_DATE:-$(date -u -d '1 year ago' '+%Y-%m-%dT00:00:00Z' 2>/dev/null || date -u -v-1y '+%Y-%m-%dT00:00:00Z')}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-US}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: stripe (from $TAP_STRIPE_START_DATE) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-stripe target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
