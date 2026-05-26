#!/usr/bin/env bash
# Liveli dbt-runner entrypoint — executed per (customer, connector) sync completion.
#
# Per-invocation env injected by the sync route:
#   WORKSPACE_ID            = customer / clientId (legacy name)
#   CLIENT_ID               = same as WORKSPACE_ID (preferred new name)
#   LIVELI_WORKSPACE_ID     = workspace within client
#   CONNECTOR_ID            = connector record ID
#   CONNECTOR_TYPE          = e.g. "ga4" / "stripe" — selects which dbt tag to run
#   TARGET_BIGQUERY_PROJECT = GCP project ID (liveli-496609)
#   TARGET_BIGQUERY_DATASET = c_<C>__w_<W>__d_<conn> — customer's per-connector dataset
#   TARGET_BIGQUERY_LOCATION = "EU" or "US" — passed through to dbt profiles.yml
#
# This script intentionally mirrors the env-var contract of the
# connector-X-to-bq entrypoints — same names, same call-time semantics.
# Liveli's sync route passes BOTH connector creds AND these dbt vars;
# the dbt-runner ignores the tap-specific TAP_* env vars entirely.

set -euo pipefail

: "${WORKSPACE_ID:?WORKSPACE_ID required (customer clientId)}"
: "${CONNECTOR_ID:?CONNECTOR_ID required}"
: "${CONNECTOR_TYPE:?CONNECTOR_TYPE required (e.g. ga4 — selects which dbt models to run via --select tag:CONNECTOR_TYPE)}"
: "${TARGET_BIGQUERY_PROJECT:?TARGET_BIGQUERY_PROJECT required}"
: "${TARGET_BIGQUERY_DATASET:?TARGET_BIGQUERY_DATASET required}"

# Default location to EU — matches the bulk of customers (residency
# split sets this explicitly anyway, but a default keeps dev / one-off
# runs unambiguous).
export TARGET_BIGQUERY_LOCATION="${TARGET_BIGQUERY_LOCATION:-EU}"

echo "→ workspace=$WORKSPACE_ID connector=$CONNECTOR_ID type=$CONNECTOR_TYPE"
echo "→ target: $TARGET_BIGQUERY_PROJECT.$TARGET_BIGQUERY_DATASET (location=$TARGET_BIGQUERY_LOCATION)"

cd /app/dbt

# Compile the vars JSON. dbt --vars expects valid YAML/JSON; we use
# JSON for unambiguous quoting. The two required vars come from env;
# anything else is left to model defaults.
DBT_VARS=$(cat <<EOF
{
  "target_project": "$TARGET_BIGQUERY_PROJECT",
  "target_dataset": "$TARGET_BIGQUERY_DATASET"
}
EOF
)

echo "→ dbt vars: $DBT_VARS"
echo "→ dbt selector: tag:$CONNECTOR_TYPE"

# Run the relevant subset of models — only those tagged with the
# CONNECTOR_TYPE. dbt's tag-based selection is exact match; if we
# eventually want fuzzier selectors (e.g. "ga4+marketing"), switch to
# `--select tag:$CONNECTOR_TYPE tag:cross_source`.
#
# --profiles-dir points at the project's own profiles.yml; default
# would look in ~/.dbt which doesn't exist in the container.
#
# --fail-fast: stop on the first failure so we don't waste compute
# trying to materialise downstream models when their upstream broke.
dbt run \
    --profiles-dir /app/dbt \
    --vars "$DBT_VARS" \
    --select "tag:$CONNECTOR_TYPE" \
    --fail-fast

# Run tests AFTER models materialise. Failures here mean a data
# quality assertion broke — surface as non-zero exit so Cloud Run
# marks the execution as failed (which the sync route will see and
# record on the connector doc as lastError).
#
# `--store-failures` would persist failing rows to a dbt_failures
# table for debugging; deferred to v2 since it adds a write
# permission requirement we haven't audited.
dbt test \
    --profiles-dir /app/dbt \
    --vars "$DBT_VARS" \
    --select "tag:$CONNECTOR_TYPE"

echo "→ dbt run + test complete"
