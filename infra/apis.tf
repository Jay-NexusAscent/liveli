locals {
  enabled_services = [
    "aiplatform.googleapis.com",       # Vertex AI (Claude)
    "artifactregistry.googleapis.com", # Docker repo for connector images
    "bigquery.googleapis.com",
    "cloudbuild.googleapis.com",       # Builds connector images
    "cloudresourcemanager.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",   # WIF
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "run.googleapis.com",              # Cloud Run + Jobs
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",              # WIF token exchange
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.enabled_services)
  project  = var.project_id
  service  = each.value

  disable_on_destroy = false
}
