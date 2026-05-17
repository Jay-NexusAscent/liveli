#!/usr/bin/env bash
set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${TAP_MYSQL_HOST:?mysql host required}"
: "${TAP_MYSQL_USER:?mysql user required}"
: "${TAP_MYSQL_PASSWORD:?mysql password required}"
: "${TAP_MYSQL_DATABASE:?mysql database required}"
: "${TARGET_BIGQUERY_PROJECT:?bq project required}"
: "${TARGET_BIGQUERY_DATASET:?bq dataset required}"

export TAP_MYSQL_PORT="${TAP_MYSQL_PORT:-3306}"
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-US}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID"
echo "→ source: mysql://$TAP_MYSQL_HOST/$TAP_MYSQL_DATABASE → bq:$TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET"

meltano elt tap-mysql target-bigquery --state-id "ws-${WORKSPACE_ID}-cn-${CONNECTOR_ID}"
