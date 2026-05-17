# Workload Identity Federation — lets GitHub Actions and Vercel
# impersonate GCP service accounts without long-lived JSON keys.

# ── GitHub Actions OIDC ───────────────────────────────────────────

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  description               = "OIDC pool for GitHub Actions runs on Jay-NexusAscent/liveli."
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions-provider"
  display_name                       = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.actor"      = "assertion.actor"
  }

  # Only accept tokens from our specific repo.
  attribute_condition = "attribute.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_can_impersonate_ci" {
  service_account_id = google_service_account.ci.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ── Vercel OIDC ───────────────────────────────────────────────────
# Vercel issues OIDC tokens scoped to a team and project so the runtime
# can impersonate the runtime SA without storing a JSON key.

resource "google_iam_workload_identity_pool" "vercel" {
  workload_identity_pool_id = "vercel"
  display_name              = "Vercel"
  description               = "OIDC pool for Vercel functions impersonating the runtime SA."
}

resource "google_iam_workload_identity_pool_provider" "vercel" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.vercel.workload_identity_pool_id
  workload_identity_pool_provider_id = "vercel-provider"
  display_name                       = "Vercel OIDC"

  attribute_mapping = {
    "google.subject"    = "assertion.sub"
    "attribute.owner"   = "assertion.owner"
    "attribute.project" = "assertion.project"
  }

  attribute_condition = "attribute.owner == \"${var.vercel_team_slug}\""

  oidc {
    issuer_uri = "https://oidc.vercel.com/${var.vercel_team_slug}"
  }
}

resource "google_service_account_iam_member" "vercel_can_impersonate_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.vercel.name}/attribute.owner/${var.vercel_team_slug}"
}
