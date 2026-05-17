resource "google_artifact_registry_repository" "connectors" {
  project       = var.project_id
  location      = var.gcp_region
  repository_id = "liveli-connectors"
  description   = "Container images for Meltano-based connector Cloud Run Jobs."
  format        = "DOCKER"

  labels = local.common_labels

  depends_on = [google_project_service.enabled]
}
