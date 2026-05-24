#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-klaviyo target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_KLAVIYO_AUTH_TOKEN:?Klaviyo Private API Key required (starts with pk_)}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: klaviyo → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
# MELTANO_STATE_BACKEND_URI tells Meltano to read/write replication
# bookmarks against a GCS bucket instead of the local filesystem. The
# sync route sets this based on the workspace's residency (EU or US);
# fallback default is EU so any direct/manual `meltano elt` invocation
# inside the container still works.
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

# State-id becomes the OBJECT NAME inside the state bucket. Tenant-
# prefixed so prefix-deletion-on-customer-delete works.
STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# See LIVELI-118 for the full rationale. Dynamic per-stream config is
# postgres-only; this entrypoint stays static.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-klaviyo target-bigquery --state-id "$STATE_ID"
