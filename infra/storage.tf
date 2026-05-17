resource "google_storage_bucket" "uploads" {
  name          = "liveli-uploads-eu"
  location      = var.gcs_location
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning { enabled = false }

  # CSV uploads are landing-zone only — once loaded into BQ, original
  # files can roll off after a week.
  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 7 }
  }

  cors {
    origin          = ["https://app.liveli.co.uk", "https://liveli.co.uk", "http://localhost:3000", "http://app.localhost:3000"]
    method          = ["GET", "PUT", "POST"]
    response_header = ["Content-Type", "x-goog-meta-*"]
    max_age_seconds = 3600
  }

  labels = local.common_labels

  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket" "agent_artifacts" {
  name          = "liveli-agent-eu"
  location      = var.gcs_location
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = local.common_labels

  depends_on = [google_project_service.enabled]
}
