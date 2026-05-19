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

meltano elt tap-mysql target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
