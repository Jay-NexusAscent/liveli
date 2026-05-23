#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-stripe target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_STRIPE_CLIENT_SECRET:?Stripe secret key required (sk_live_... or sk_test_...)}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

# Default the historical window to 1 year ago when the connect route
# doesn't set one. GNU date (Linux/CI) supports `-d "1 year ago"`;
# BSD date (macOS local dev) needs `-v-1y`. Try GNU first, fall back.
export TAP_STRIPE_START_DATE="${TAP_STRIPE_START_DATE:-$(date -u -d '1 year ago' '+%Y-%m-%dT00:00:00Z' 2>/dev/null || date -u -v-1y '+%Y-%m-%dT00:00:00Z')}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: stripe (from $TAP_STRIPE_START_DATE) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

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
# Dynamic per-stream config (LIVELI_REPLICATION_CONFIG) is a
# postgres-only mechanism wired to lib/postgres-introspection.ts.
# Re-adding it here requires the loader to be `upsert: true` AND the
# tap to emit `key_properties` for every stream — otherwise an
# `overwrite: true` loader combined with INCREMENTAL replication
# wipes all historical data on every sync after the first (see
# LIVELI-111). The tap-stripe loader IS on upsert and the tap emits
# key_properties from the source's `id` field, so re-enabling here
# would be safe — but until there's a concrete need (e.g. per-tenant
# stream selection), keep it absent to reduce the surface area.

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-stripe target-bigquery --state-id "$STATE_ID"
