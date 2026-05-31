#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-snowflake target-bigquery`.
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_SNOWFLAKE_ACCOUNT:?Snowflake account required}"
: "${TAP_SNOWFLAKE_USER:?Snowflake user required}"
: "${TAP_SNOWFLAKE_PASSWORD:?Snowflake password required}"
: "${TAP_SNOWFLAKE_DATABASE:?Snowflake database required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: snowflake/$TAP_SNOWFLAKE_DATABASE → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication + per-stream loader modes ──────────────
# Auto-generated at connect time by lib/snowflake-introspection.ts:
#
#   LIVELI_REPLICATION_CONFIG — JSON map stream `<SCHEMA>-<TABLE>` →
#     { replication-method, replication-key }. → extractor `metadata:`.
#   LIVELI_UPSERT_STREAMS — JSON array of stream patterns to MERGE on the
#     PK. → loader `upsert` (fnmatch list).
#   LIVELI_OVERWRITE_STREAMS — JSON array of stream patterns to atomically
#     replace each run. → loader `overwrite` (fnmatch list).
#
# Streams in neither loader list APPEND (z3z1ma default). Snowflake has
# no enforced PKs, so this per-stream routing — not a single global mode
# — is what keeps incremental syncs cheap without wiping no-PK tables.
if [ -n "${LIVELI_REPLICATION_CONFIG:-}" ] || [ -n "${LIVELI_UPSERT_STREAMS:-}" ] || [ -n "${LIVELI_OVERWRITE_STREAMS:-}" ]; then
  echo "→ merging replication config + loader modes into meltano.yml"
  python3 <<'PY'
import json, os, yaml

with open("/project/meltano.yml") as f:
    cfg = yaml.safe_load(f)

extractor = cfg["plugins"]["extractors"][0]
loader = cfg["plugins"]["loaders"][0]

# 1) Per-stream tap replication metadata.
overrides = json.loads(os.environ.get("LIVELI_REPLICATION_CONFIG", "{}"))
if overrides:
    existing = extractor.get("metadata", {}) or {}
    existing.update(overrides)
    extractor["metadata"] = existing

# 2) Per-stream loader write modes. z3z1ma accepts fnmatch pattern lists
#    on `upsert` and `overwrite`; anything matching neither appends.
loader_cfg = loader.get("config", {}) or {}
upsert = json.loads(os.environ.get("LIVELI_UPSERT_STREAMS", "[]"))
overwrite = json.loads(os.environ.get("LIVELI_OVERWRITE_STREAMS", "[]"))
if upsert:
    loader_cfg["upsert"] = upsert
if overwrite:
    loader_cfg["overwrite"] = overwrite
loader["config"] = loader_cfg

with open("/project/meltano.yml", "w") as f:
    yaml.safe_dump(cfg, f, sort_keys=False)

for stream, conf in overrides.items():
    method = conf.get("replication-method", "?")
    key = conf.get("replication-key", "")
    print(f"   {stream}: {method}{(' by ' + key) if key else ''}")
print(f"   loader upsert patterns: {upsert}")
print(f"   loader overwrite patterns: {overwrite}")
PY
fi

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-snowflake target-bigquery --state-id "$STATE_ID"
