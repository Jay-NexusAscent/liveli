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

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: $TAP_POSTGRES_HOST/$TAP_POSTGRES_DATABASE → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-postgres target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
