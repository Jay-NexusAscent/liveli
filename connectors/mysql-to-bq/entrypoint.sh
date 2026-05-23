#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-mysql target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID is required}"
: "${CONNECTOR_ID:?CONNECTOR_ID is required}"
: "${TAP_MYSQL_HOST:?mysql host required}"
: "${TAP_MYSQL_USER:?mysql user required}"
: "${TAP_MYSQL_PASSWORD:?mysql password required}"
: "${TAP_MYSQL_DATABASE:?mysql database required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TAP_MYSQL_PORT="${TAP_MYSQL_PORT:-3306}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: $TAP_MYSQL_HOST/$TAP_MYSQL_DATABASE → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
# MELTANO_STATE_BACKEND_URI tells Meltano to read/write replication
# bookmarks against a GCS bucket instead of the local filesystem. The
# sync route sets this based on the workspace's residency (EU or US);
# fallback default is EU so any direct/manual `meltano elt` invocation
# inside the container still works. Without persistence Meltano falls
# back to local filesystem state, which dies with the container —
# defeats incremental sync regardless of tap config.
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

# State-id becomes the OBJECT NAME inside the state bucket. Tenant-
# prefixed so prefix-deletion-on-customer-delete works: deleting a
# client is a single `gsutil rm -r gs://.../<clientId>/**` call
# (handled in lib/clients.ts deleteClient via lib/meltano-state.ts).
STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# DO NOT re-enable LIVELI_REPLICATION_CONFIG handling here without
# first flipping the loader from `overwrite: true` to `upsert: true`
# (see meltano.yml above). The combination of an overwrite loader
# with INCREMENTAL-mode streams (which is what the merge block would
# set) wiped two years of demo data in LIVELI-111. The mysql tap
# defaults to FULL_TABLE which is safe under overwrite; keep it that
# way until the loader contract is fixed and PK gating equivalent to
# lib/postgres-introspection.ts has been built for mysql tables.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-mysql target-bigquery --state-id "$STATE_ID"
