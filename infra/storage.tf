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

# ── Meltano state backends ────────────────────────────────────────
#
# Two regional buckets matching the Cloud Run Job residency split.
# Each connector writes its Singer/Meltano replication bookmarks to a
# tenant-prefixed object path:
#   gs://liveli-meltano-state-<region>/<clientId>/<workspaceId>/<connectorId>.json
#
# Why two buckets, not one per customer or one per connector:
#   - State files are pointers (bookmark values, ~1 KB each), not data.
#     Cross-tenant exposure of bookmarks is essentially non-impacting.
#   - Per-customer/per-connector buckets multiply IAM, lifecycle, audit
#     policies. At thousands of connectors we'd hit GCP's per-project
#     bucket cap. Single regional bucket + path-prefix tenant scoping
#     is right for this sensitivity level.
#   - Residency split is mandatory — bookmark values reference customer
#     data timestamps, so they should stay in the same multi-region as
#     the workspace's BQ data.
#
# True tenant isolation (per-client SA + IAM Conditions on path) is
# Phase 2 work and operates on the SAME single-region bucket — the
# tenant-prefixed path makes that migration zero-effort when it lands.
#
# Versioning enabled so accidental delete/overwrite of a state file is
# recoverable (gives at least one prior bookmark to roll back to).
# Lifecycle prunes noncurrent versions after 30d to bound storage.

resource "google_storage_bucket" "meltano_state_eu" {
  name          = "liveli-meltano-state-eu"
  location      = "EU"
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning { enabled = true }

  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age                = 30
      with_state         = "ARCHIVED"
      num_newer_versions = 1
    }
  }

  labels = local.common_labels

  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket" "meltano_state_us" {
  name          = "liveli-meltano-state-us"
  location      = "US"
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning { enabled = true }

  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age                = 30
      with_state         = "ARCHIVED"
      num_newer_versions = 1
    }
  }

  labels = local.common_labels

  depends_on = [google_project_service.enabled]
}
