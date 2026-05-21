#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-postgres target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID is required}"
: "${CONNECTOR_ID:?CONNECTOR_ID is required}"
: "${TAP_POSTGRES_HOST:?postgres host required}"
: "${TAP_POSTGRES_USER:?postgres user required}"
: "${TAP_POSTGRES_PASSWORD:?postgres password required}"
: "${TAP_POSTGRES_DATABASE:?postgres database required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TAP_POSTGRES_PORT="${TAP_POSTGRES_PORT:-5432}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

# ── Persistent Meltano state backend on GCS ────────────────────────
# MELTANO_STATE_BACKEND_URI tells Meltano to read/write replication
# bookmarks against a GCS bucket instead of the local filesystem. The
# sync route sets this based on the workspace's residency (EU or US)
# so EU customer state lives in liveli-meltano-state-eu, US in -us.
# When unset (defensive fallback), Meltano uses local filesystem state
# — which dies with the container, defeating incremental sync.
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

# State-id is the OBJECT NAME inside the state bucket. Tenant-prefixed
# so prefix-deletion-on-customer-delete works: deleting a client
# becomes `gsutil rm -r gs://.../<clientId>/**` (handled in
# lib/clients.ts deleteClient). The slash-delimited form is preserved
# by GCS as folder structure — easy to browse + cheap to bulk-delete.
#
# CLIENT_ID + LIVELI_WORKSPACE_ID are set by both the user-triggered
# sync route and the Cloud-Scheduler-triggered scheduled-sync route.
# Fall back to legacy WORKSPACE_ID for connectors that pre-date the
# multi-tenant rename (those don't have CLIENT_ID set — but state will
# still be stored, just under the legacy path).
STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── INCREMENTAL replication DISABLED — see LIVELI-111 ──────────────
# The merge step below has been deliberately disabled. The combination
# of `replication-method: INCREMENTAL` (which this env var sets per
# stream) with the loader's `overwrite: true` mode (meltano.yml line
# ~70) is catastrophic: each incremental sync emits only the delta
# WHERE replication-key > bookmark, and `overwrite` then REPLACES the
# entire target table with that small delta. All historical data is
# wiped on every sync after the first.
#
# Until we ship PK detection + a switch to `upsert: true` for tables
# with a single-column PK (LIVELI-111 follow-up), every postgres
# stream MUST stay on FULL_TABLE replication (the tap-postgres default
# when no `metadata:` overrides are present) — that's the only mode
# safe to combine with `overwrite: true`.
#
# `lib/connector-env.ts` was updated to stop passing this env var,
# but defence-in-depth here ensures the merge cannot happen even if
# an older sync route or a manual job invocation supplies it anyway.
if [ -n "${LIVELI_REPLICATION_CONFIG:-}" ]; then
  echo "→ WARNING: LIVELI_REPLICATION_CONFIG is set, but the merge step"
  echo "  is disabled (see LIVELI-111). Ignoring; all streams will use"
  echo "  FULL_TABLE replication, which is the only mode safe with the"
  echo "  loader's overwrite: true setting."
fi

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID state=$STATE_ID"
echo "→ source: $TAP_POSTGRES_HOST/$TAP_POSTGRES_DATABASE → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"
echo "→ state backend: $MELTANO_STATE_BACKEND_URI"

meltano elt tap-postgres target-bigquery --state-id "$STATE_ID"
