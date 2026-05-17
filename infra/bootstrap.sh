#!/usr/bin/env bash
# Bootstrap: create the GCS bucket that holds Terraform state.
# One-time, runs before `terraform init`. Idempotent — safe to re-run.

set -euo pipefail

PROJECT_ID="${1:-liveli-496609}"
BUCKET_NAME="liveli-tf-state-eu"
LOCATION="EU"

echo "→ Project: $PROJECT_ID"
echo "→ State bucket: gs://$BUCKET_NAME (location $LOCATION)"

if gcloud storage buckets describe "gs://$BUCKET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "✓ Bucket already exists, skipping create."
else
  gcloud storage buckets create "gs://$BUCKET_NAME" \
    --project="$PROJECT_ID" \
    --location="$LOCATION" \
    --uniform-bucket-level-access \
    --public-access-prevention
  echo "✓ Created."
fi

# Enable object versioning so we never lose state on a bad apply.
gcloud storage buckets update "gs://$BUCKET_NAME" \
  --project="$PROJECT_ID" \
  --versioning >/dev/null
echo "✓ Versioning enabled."

echo
echo "Next:"
echo "  cd infra && terraform init && terraform plan"
