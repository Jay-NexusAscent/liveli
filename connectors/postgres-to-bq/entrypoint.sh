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

# ── Per-stream replication overrides + exclusion list ─────────────
# Two related env vars from the app, both auto-generated at connect
# time by lib/postgres-introspection.ts:
#
#   LIVELI_REPLICATION_CONFIG — JSON object mapping stream name
#     (`<schema>-<table>`) → { replication-method, replication-key }.
#     Drives the `metadata:` block of meltano.yml.
#
#   LIVELI_EXCLUDED_STREAMS — JSON array of stream names to EXCLUDE
#     from sync entirely. These are tables without a single-column
#     primary key — incompatible with the loader's `upsert: true`
#     MERGE step (would silently corrupt). Drives the `select:`
#     filter of meltano.yml as `!<stream>.*` exclusions.
#
# Merged into meltano.yml using Python's yaml module (already in the
# meltano base image) — more robust than awk/sed against the YAML
# structure. When both env vars are unset (legacy connectors), every
# discovered stream syncs with Meltano's default replication method
# (FULL_TABLE) — still safe under upsert because tap-postgres emits
# key_properties from real PKs.
if [ -n "${LIVELI_REPLICATION_CONFIG:-}" ] || [ -n "${LIVELI_EXCLUDED_STREAMS:-}" ]; then
  echo "→ merging replication config + exclusions into meltano.yml"
  python3 <<'PY'
import json, os, yaml

with open("/project/meltano.yml") as f:
    cfg = yaml.safe_load(f)

extractor = cfg["plugins"]["extractors"][0]

# 1) Per-stream replication metadata (INCREMENTAL vs FULL_TABLE + key).
overrides = json.loads(os.environ.get("LIVELI_REPLICATION_CONFIG", "{}"))
if overrides:
    existing = extractor.get("metadata", {}) or {}
    existing.update(overrides)
    extractor["metadata"] = existing

# 2) Exclude no-PK streams via a select-filter denylist. Meltano's
#    select syntax: ["*.*"] includes everything by default; prepend
#    "!<stream>.*" entries to subtract specific streams. We build the
#    full filter explicitly so a missing default doesn't accidentally
#    leave the denylist empty.
excluded = json.loads(os.environ.get("LIVELI_EXCLUDED_STREAMS", "[]"))
if excluded:
    select = ["*.*"]
    for stream in excluded:
        select.append(f"!{stream}.*")
    extractor["select"] = select

with open("/project/meltano.yml", "w") as f:
    yaml.safe_dump(cfg, f, sort_keys=False)

# Echo summary so Cloud Run Job logs surface what each stream is doing.
for stream, conf in overrides.items():
    method = conf.get("replication-method", "?")
    key = conf.get("replication-key", "")
    print(f"   {stream}: {method}{(' by ' + key) if key else ''}")
for stream in excluded:
    print(f"   {stream}: EXCLUDED (no single-column PK — incompatible with upsert MERGE)")
PY
fi

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID state=$STATE_ID"
echo "→ source: $TAP_POSTGRES_HOST/$TAP_POSTGRES_DATABASE → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"
echo "→ state backend: $MELTANO_STATE_BACKEND_URI"

meltano elt tap-postgres target-bigquery --state-id "$STATE_ID"
