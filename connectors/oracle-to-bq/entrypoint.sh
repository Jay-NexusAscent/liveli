#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-oracle target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_ORACLE_HOST:?Oracle host required}"
: "${TAP_ORACLE_USER:?Oracle user required}"
: "${TAP_ORACLE_PASSWORD:?Oracle password required}"
: "${TAP_ORACLE_SERVICE_NAME:?Oracle service_name required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TAP_ORACLE_PORT="${TAP_ORACLE_PORT:-1521}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: $TAP_ORACLE_HOST/$TAP_ORACLE_SERVICE_NAME (Oracle) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides + exclusion list ─────────────
# Auto-generated at connect time by lib/oracle-introspection.ts, same
# contract as the postgres connector:
#
#   LIVELI_REPLICATION_CONFIG — JSON map of stream `<OWNER>-<TABLE>` →
#     { replication-method, replication-key }. Merged into the extractor
#     `metadata:` block.
#   LIVELI_EXCLUDED_STREAMS — JSON array of streams with no single-column
#     PK (incompatible with the loader's upsert MERGE). Written into the
#     `select:` filter as `!<stream>.*`.
#
# Loader runs `upsert: true` (see meltano.yml); tap-oracle emits
# key_properties from enforced PKs so MERGE preserves history.
if [ -n "${LIVELI_REPLICATION_CONFIG:-}" ] || [ -n "${LIVELI_EXCLUDED_STREAMS:-}" ]; then
  echo "→ merging replication config + exclusions into meltano.yml"
  python3 <<'PY'
import json, os, yaml

with open("/project/meltano.yml") as f:
    cfg = yaml.safe_load(f)

extractor = cfg["plugins"]["extractors"][0]

overrides = json.loads(os.environ.get("LIVELI_REPLICATION_CONFIG", "{}"))
if overrides:
    existing = extractor.get("metadata", {}) or {}
    existing.update(overrides)
    extractor["metadata"] = existing

excluded = json.loads(os.environ.get("LIVELI_EXCLUDED_STREAMS", "[]"))
if excluded:
    select = ["*.*"]
    for stream in excluded:
        select.append(f"!{stream}.*")
    extractor["select"] = select

with open("/project/meltano.yml", "w") as f:
    yaml.safe_dump(cfg, f, sort_keys=False)

for stream, conf in overrides.items():
    method = conf.get("replication-method", "?")
    key = conf.get("replication-key", "")
    print(f"   {stream}: {method}{(' by ' + key) if key else ''}")
for stream in excluded:
    print(f"   {stream}: EXCLUDED (no single-column PK — incompatible with upsert MERGE)")
PY
fi

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-oracle target-bigquery --state-id "$STATE_ID"
