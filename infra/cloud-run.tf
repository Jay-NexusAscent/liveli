# Connector job template. The actual image is published by the
# deploy-connectors GitHub Actions workflow whenever connectors/** changes.
# At first apply the placeholder image is `hello-world` — replace by running
# the workflow once.

resource "google_cloud_run_v2_job" "connector_postgres_to_bq" {
  name     = "connector-postgres-to-bq"
  location = var.gcp_region
  project  = var.project_id

  template {
    template {
      service_account = google_service_account.connector.email

      max_retries = 1
      timeout     = "1800s" # 30 minutes max per run

      containers {
        # Placeholder. The GitHub Actions workflow replaces this with
        # europe-west4-docker.pkg.dev/liveli-496609/liveli-connectors/postgres-to-bq:<sha>
        image = "us-docker.pkg.dev/cloudrun/container/hello"

        resources {
          limits = {
            cpu    = "2"
            memory = "4Gi"
          }
        }

        # Real env is injected per-invocation by the app, including
        # WORKSPACE_ID, CONNECTOR_ID, and a Secret Manager reference.
      }
    }
  }

  labels = local.common_labels

  depends_on = [
    google_project_service.enabled,
    google_artifact_registry_repository.connectors,
  ]

  # Image is managed by CI/CD, not Terraform.
  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}
