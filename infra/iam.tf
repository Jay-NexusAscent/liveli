# Three service accounts, one per role:
#  - liveli-ci       : used by GitHub Actions (broad — manages infra)
#  - liveli-runtime  : used by Vercel runtime (narrow — data plane only)
#  - liveli-connector: used by Cloud Run connector jobs (narrow — single workspace)

resource "google_service_account" "ci" {
  account_id   = "liveli-ci"
  display_name = "Liveli — CI/CD (GitHub Actions)"
  description  = "Impersonated via Workload Identity Federation from Jay-NexusAscent/liveli Actions runs."
}

resource "google_service_account" "runtime" {
  account_id   = "liveli-runtime"
  display_name = "Liveli — App runtime (Vercel)"
  description  = "Impersonated via Vercel OIDC. Queries BQ, reads Secret Manager, calls Vertex AI, reads/writes Firestore + GCS."
}

resource "google_service_account" "connector" {
  account_id   = "liveli-connector"
  display_name = "Liveli — Connector jobs (Cloud Run)"
  description  = "Runs Meltano ELT pipelines. Reads connector secrets, writes to workspace BQ datasets, writes to GCS."
}

# ── Roles for the CI account ──────────────────────────────────────
# Broad infra management. Trimmed from Owner to specific roles.
locals {
  ci_roles = [
    "roles/bigquery.admin",
    "roles/storage.admin",
    "roles/secretmanager.admin",
    "roles/run.admin",
    "roles/artifactregistry.admin",
    "roles/datastore.owner", # Firestore
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/serviceusage.serviceUsageAdmin",
    # Needed for `google_project_iam_member` resources — they call
    # projects.getIamPolicy at refresh time. Without it, terraform plan
    # 403s on every IAM member read.
    "roles/resourcemanager.projectIamAdmin",
  ]
}

resource "google_project_iam_member" "ci" {
  for_each = toset(local.ci_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.ci.email}"
}

# ── Roles for the runtime account ─────────────────────────────────
# Narrow — only what the app needs at request time.
locals {
  runtime_roles = [
    "roles/bigquery.jobUser",    # Submit queries
    "roles/bigquery.dataEditor", # Read/write workspace datasets
    # The runtime CREATES connector secrets at connect time
    # (storeConnectorSecret -> client.createSecret), ADDS versions when
    # creds change, and ACCESSES payloads at sync time. secretAccessor
    # alone only covers access; create requires admin (or a custom role
    # bundling secrets.create + versions.add + versions.access).
    "roles/secretmanager.admin",
    "roles/storage.objectUser",
    "roles/datastore.user",  # Firestore read/write
    "roles/aiplatform.user", # Vertex AI Claude calls
    "roles/run.invoker",     # Trigger connector jobs
  ]
}

resource "google_project_iam_member" "runtime" {
  for_each = toset(local.runtime_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

# ── Roles for the connector account ───────────────────────────────
locals {
  connector_roles = [
    "roles/bigquery.dataEditor",
    "roles/bigquery.jobUser",
    "roles/secretmanager.secretAccessor",
    "roles/storage.objectUser",
    "roles/logging.logWriter",
  ]
}

resource "google_project_iam_member" "connector" {
  for_each = toset(local.connector_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.connector.email}"
}
