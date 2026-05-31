#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-bigquery target-bigquery`.
# Source is the CUSTOMER's BigQuery project; target is the Liveli workspace
# dataset. Per-invocation env is injected by the Cloud Run Job trigger.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID is required}"
: "${CONNECTOR_ID:?CONNECTOR_ID is required}"
: "${TAP_BIGQUERY_PROJECT_ID:?source bigquery project required}"
: "${TAP_BIGQUERY_CREDENTIALS_JSON:?source bigquery SA-key JSON required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

# tap-bigquery only accepts a credentials FILE PATH (no inline-JSON
# setting). Materialise the customer-supplied SA key to a file with
# tight permissions and point the tap at it. /tmp is the only writable
# path in the Cloud Run Job filesystem.
CREDS_FILE="/tmp/source-bq-sa.json"
umask 077
printf '%s' "$TAP_BIGQUERY_CREDENTIALS_JSON" > "$CREDS_FILE"
export TAP_BIGQUERY_CREDENTIALS_PATH="$CREDS_FILE"
# Don't leave the raw key in the tap's env once it's on disk — the tap
# reads the file, not this var.
unset TAP_BIGQUERY_CREDENTIALS_JSON

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: bq:$TAP_BIGQUERY_PROJECT_ID → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-bigquery target-bigquery --state-id "$STATE_ID"
