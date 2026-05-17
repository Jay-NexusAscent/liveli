output "project_id" {
  value = var.project_id
}

output "vertex_region" {
  value = var.vertex_region
}

output "artifact_registry_repo" {
  value = "${google_artifact_registry_repository.connectors.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.connectors.repository_id}"
}

output "uploads_bucket" {
  value = google_storage_bucket.uploads.name
}

output "agent_artifacts_bucket" {
  value = google_storage_bucket.agent_artifacts.name
}

# ── Values to copy into GitHub Actions repo variables / secrets ───

output "github_wif_provider" {
  description = "Set as repo variable GCP_WORKLOAD_IDENTITY_PROVIDER."
  value       = "projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/providers/${google_iam_workload_identity_pool_provider.github.workload_identity_pool_provider_id}"
}

output "ci_service_account_email" {
  description = "Set as repo variable GCP_CI_SERVICE_ACCOUNT."
  value       = google_service_account.ci.email
}

output "runtime_service_account_email" {
  description = "Set as Vercel env GCP_RUNTIME_SERVICE_ACCOUNT."
  value       = google_service_account.runtime.email
}

output "vercel_wif_audience" {
  description = "Set as Vercel env GCP_WORKLOAD_IDENTITY_PROVIDER for runtime impersonation."
  value       = "//iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.vercel.workload_identity_pool_id}/providers/${google_iam_workload_identity_pool_provider.vercel.workload_identity_pool_provider_id}"
}

data "google_project" "current" {
  project_id = var.project_id
}
