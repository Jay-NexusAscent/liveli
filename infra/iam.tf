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
    # run.admin (not run.invoker, not run.developer).
    # - run.invoker only covers run.jobs.run (no overrides) — we use overrides
    #   to inject per-invocation env (creds, workspace, target BQ dataset)
    # - run.developer SHOULD include runWithOverrides per docs but in practice
    #   the grant didn't propagate or doesn't include it in this project's
    #   GCP version. run.admin definitively covers it.
    # - Also forward-compatible with per-tenant Jobs migration (LIVELI-49)
    #   where the runtime CREATES Jobs at connect time and DELETES on
    #   disconnect — both covered by admin.
    # Narrow to a custom role with exactly the perms we need post-demo.
    "roles/run.admin",
    # Read Cloud Run Job execution logs for the in-flight sync progress
    # endpoint (parses Meltano stdout for record counts). Read-only;
    # never writes to logging.
    "roles/logging.viewer",
    # Cloud Scheduler: create/update/delete per-connector recurring jobs.
    # The runtime creates these on connector connect, removes them on
    # delete, updates the cron on frequency change. (LIVELI-50)
    "roles/cloudscheduler.admin",
  ]
}

# Cloud Scheduler signs OIDC tokens AS the runtime SA. Two self-IAM
# bindings are needed for this to work end-to-end:
#
#  1. tokenCreator on self — lets the runtime mint OIDC tokens AS itself
#     at job-fire time. Permissions: signBlob, signJwt, getOpenIdToken.
#
#  2. serviceAccountUser on self — lets the runtime CREATE a Cloud
#     Scheduler job whose httpTarget.oidcToken.serviceAccountEmail
#     points at itself. Includes iam.serviceAccounts.actAs, which the
#     Scheduler createJob API requires on the OIDC SA. (tokenCreator
#     does NOT include actAs — they look interchangeable but the first
#     is "mint tokens", the second is "attach SA to a resource that
#     will run as it"; createJob is the latter flow.)
#
# Both bindings need to coexist; removing either silently breaks
# upsertSyncJob with a "lacks permission iam.serviceAccounts.actAs"
# audit-log error that the soft-fail try/catch in lib/cloud-scheduler.ts
# swallows. Symptom: connectors never sync on the recurring schedule.
resource "google_service_account_iam_member" "runtime_token_creator_self" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_service_account_iam_member" "runtime_user_self" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime.email}"
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
    # `roles/bigquery.user` (superset of bigquery.jobUser). The
    # additional permission we need beyond jobUser is
    # `bigquery.jobs.update`, used by dbt-bigquery 1.9 to poll/cancel
    # in-flight query jobs. Without it, dbt-runner fails partway through
    # materialising tables with "Access Denied: ... Permission
    # bigquery.jobs.update denied on job ..." (LIVELI-54 dbt-runner
    # first-execution failure).
    #
    # `bigquery.user` also grants `bigquery.datasets.create` on the
    # project, but in practice that's redundant — dataset creation is
    # already governed by app-level code (provisionConnector) and
    # always scoped to the customer's clientId+workspaceId. No
    # additional cross-customer surface vs jobUser+dataEditor.
    "roles/bigquery.user",
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
