#!/usr/bin/env bash
# Reads connector config from env, runs `meltano elt tap-mysql target-bigquery`
# against a MariaDB instance (MySQL-wire-compatible).
# Per-invocation env is injected by the Cloud Run Job trigger from the app.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID is required}"
: "${CONNECTOR_ID:?CONNECTOR_ID is required}"
: "${TAP_MYSQL_HOST:?mariadb host required}"
: "${TAP_MYSQL_USER:?mariadb user required}"
: "${TAP_MYSQL_PASSWORD:?mariadb password required}"
: "${TAP_MYSQL_DATABASE:?mariadb database required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TAP_MYSQL_PORT="${TAP_MYSQL_PORT:-3306}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: $TAP_MYSQL_HOST/$TAP_MYSQL_DATABASE (MariaDB) → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

# ── Persistent Meltano state backend on GCS ────────────────────────
export MELTANO_STATE_BACKEND_URI="${MELTANO_STATE_BACKEND_URI:-gs://liveli-meltano-state-eu}"

STATE_ID="${CLIENT_ID:-$WORKSPACE_ID}/${LIVELI_WORKSPACE_ID:-default}/${CONNECTOR_ID}"

# ── Per-stream replication overrides — intentionally absent ───────
# overwrite + FULL_TABLE, same contract as mysql. DO NOT re-enable
# LIVELI_REPLICATION_CONFIG without first flipping the loader to upsert
# AND building PK gating (see LIVELI-111).

echo "→ state backend: $MELTANO_STATE_BACKEND_URI"
echo "→ state id: $STATE_ID"

meltano elt tap-mysql target-bigquery --state-id "$STATE_ID"
