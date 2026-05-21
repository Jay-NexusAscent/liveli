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

# ── Optional per-stream replication overrides ──────────────────────
# When LIVELI_REPLICATION_CONFIG is set (today: postgres only via
# connect-time introspection in lib/postgres-introspection.ts), merge
# the JSON into meltano.yml's extractor `metadata:` block before
# invoking meltano elt. Future per-tenant overrides for any connector
# (e.g. "user disabled syncing of Stripe payouts stream") use the
# same channel — that's why the merge step lives in EVERY connector's
# entrypoint, not just postgres. Harmless no-op when unset.
if [ -n "${LIVELI_REPLICATION_CONFIG:-}" ]; then
  echo "→ merging per-stream replication config into meltano.yml"
  python3 <<'PY'
import json, os, yaml
with open("/project/meltano.yml") as f:
    cfg = yaml.safe_load(f)
overrides = json.loads(os.environ["LIVELI_REPLICATION_CONFIG"])
extractor = cfg["plugins"]["extractors"][0]
existing = extractor.get("metadata", {}) or {}
existing.update(overrides)
extractor["metadata"] = existing
with open("/project/meltano.yml", "w") as f:
    yaml.safe_dump(cfg, f, sort_keys=False)
for stream, conf in overrides.items():
    method = conf.get("replication-method", "?")
    key = conf.get("replication-key", "")
    print(f"   {stream}: {method}{(' by ' + key) if key else ''}")
PY
fi

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-stripe target-bigquery --state-id "$STATE_ID"
