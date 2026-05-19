# One Cloud Run Job per connector type. Each runs the corresponding
# Meltano image from Artifact Registry. Per-invocation env (WORKSPACE_ID,
# CONNECTOR_ID, source credentials, target BQ project + dataset) is
# injected at run time by the app's /api/connections/{id}/sync route via
# `gcloud run jobs execute --update-env-vars`.
#
# Images are placeholders until the deploy-connectors workflow runs;
# Terraform ignores the image field via lifecycle so workflow updates
# don't drift.

locals {
  connector_types = [
    "postgres-to-bq",
    "mysql-to-bq",
    "stripe-to-bq",
    "shopify-to-bq",
    "hubspot-to-bq",
    "google-ads-to-bq",
    "facebook-ads-to-bq",
    "salesforce-to-bq",
    "mailchimp-to-bq",
  ]
}

resource "google_cloud_run_v2_job" "connector" {
  for_each = toset(local.connector_types)

  name     = "connector-${each.key}"
  location = var.gcp_region
  project  = var.project_id

  template {
    template {
      service_account = google_service_account.connector.email
      max_retries     = 1
      timeout         = "1800s" # 30 minutes max per run

      containers {
        # Placeholder — replaced by deploy-connectors workflow.
        image = "us-docker.pkg.dev/cloudrun/container/hello"

        resources {
          limits = {
            cpu    = "2"
            memory = "4Gi"
          }
        }
      }
    }
  }

  labels = local.common_labels

  depends_on = [
    google_project_service.enabled,
    google_artifact_registry_repository.connectors,
  ]

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}
