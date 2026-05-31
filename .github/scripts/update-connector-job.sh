#!/usr/bin/env bash
#
# Update a connector's Cloud Run Job image, waiting for the job to
# exist first.
#
# Why the wait: the Terraform workflow (which CREATES the jobs) and the
# deploy-connectors workflow (which updates their images) both fire on a
# push to main, in parallel with no dependency between them. For a
# brand-new connector type the job may not exist yet when deploy reaches
# the update step, and `gcloud run jobs update` requires an existing job
# (it 404s otherwise). We poll `jobs describe` for up to ~6 minutes to
# give the Terraform apply time to create the job, then update it.
#
# For existing connectors the describe succeeds immediately, so there is
# no added latency on the common path. If the job still doesn't exist
# after the timeout, the final `update` runs and fails loudly — which
# surfaces a connector dir added without a matching entry in
# local.connector_types in infra/cloud-run.tf.
#
# Required env (provided by the workflow):
#   IMAGE_URI   — fully-qualified image ref to deploy
#   PROJECT_ID  — GCP project id
#
# Args:
#   $1 — Cloud Run Job name (e.g. connector-postgres-to-bq-eu)
#   $2 — region (e.g. europe-west1)

set -euo pipefail

JOB_NAME="${1:?job name required}"
REGION="${2:?region required}"

: "${IMAGE_URI:?IMAGE_URI env var required}"
: "${PROJECT_ID:?PROJECT_ID env var required}"

MAX_ATTEMPTS=36   # 36 × 10s = 360s (~6 min)
SLEEP_SECONDS=10

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if gcloud run jobs describe "$JOB_NAME" \
       --region "$REGION" \
       --project "$PROJECT_ID" >/dev/null 2>&1; then
    break
  fi
  echo "Job '$JOB_NAME' not found in $REGION yet (attempt ${attempt}/${MAX_ATTEMPTS}); waiting for Terraform to create it…"
  sleep "$SLEEP_SECONDS"
done

echo "Updating '$JOB_NAME' ($REGION) → $IMAGE_URI"
gcloud run jobs update "$JOB_NAME" \
  --image "$IMAGE_URI" \
  --region "$REGION" \
  --project "$PROJECT_ID"
