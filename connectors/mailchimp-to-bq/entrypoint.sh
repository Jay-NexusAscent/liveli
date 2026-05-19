#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-mailchimp target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_MAILCHIMP_API_KEY:?Mailchimp API key required (with -usN suffix)}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: mailchimp → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-mailchimp target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
