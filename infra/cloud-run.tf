# Two Cloud Run Jobs per connector type — one in europe-west1 (EU
# residency), one in us-central1 (US residency). The app routes each
# sync request to the region matching the workspace's bqLocation, so
# customer data + compute stay together. See
# cloudComputeRegionForResidency() in src/lib/gcp.ts.
#
# Job names: `connector-<type>-to-bq-<suffix>` where suffix is `eu` or
# `us`. The suffix scopes the otherwise-identical job name within a
# region — and lets the app construct the name from the same residency
# mapping the routing uses.
#
# Per-invocation env (WORKSPACE_ID, CONNECTOR_ID, credentials, target
# BQ dataset, target BQ location) is injected at run time by the
# sync route. Images are placeholders until the deploy-connectors
# workflow runs; Terraform ignores the image field via lifecycle so
# workflow updates don't drift.

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
    # Batch A (LIVELI-126): API-key-only SaaS connectors.
    "klaviyo-to-bq",
    "intercom-to-bq",
    "slack-to-bq",
    "github-to-bq",
    "linear-to-bq",
    # Batch B (LIVELI-128): API-key + identifier SaaS connectors.
    "mixpanel-to-bq",
    # amplitude-to-bq TEMPORARILY re-added — see the comment block
    # below + the follow-up "remove amplitude-to-bq" PR. This is here
    # ONLY to give Terraform a chance to update deletion_protection=false
    # on these two existing Cloud Run Jobs before they're destroyed.
    # Once this apply lands and the flag has propagated, the follow-up
    # PR removes this line and the destroy succeeds cleanly.
    #
    # Two-step apply is required because Terraform's plan for a
    # resource being destroyed doesn't include attribute updates —
    # it goes straight to destroy, which trips the deletion_protection
    # guard. By keeping amplitude in the for_each map, this apply
    # plans an UPDATE on those two jobs (deletion_protection: true → false)
    # rather than a destroy. The follow-up PR's apply then plans a
    # destroy against the now-updated jobs, which Terraform permits.
    #
    # If you're reading this in main + the follow-up PR has merged, the
    # comment block above ("amplitude REMOVED in LIVELI-132") was the
    # right description — this is a transient state.
    "amplitude-to-bq",
    "jira-to-bq",
    "zendesk-to-bq",
    # Batch C (LIVELI-132): OAuth refresh-token SaaS connectors.
    # The Cloud Run Job pulls Liveli's OAuth app creds at run time from
    # Secret Manager (liveli-oauth-{google,intuit}-client-{id,secret})
    # via buildLiveliOauthEnv() — no Job-spec changes needed for that.
    "ga4-to-bq",
    "quickbooks-to-bq",
    # LIVELI-54: dbt transformation layer. ONE shared Job (per
    # residency region) handles dbt for ALL connector types — models
    # are tagged inside the dbt project, dbt-runner selects which
    # subset to run per execution via `--select tag:<connector_type>`.
    # Adding a 27th connector with dbt support = ZERO new Cloud Run
    # Jobs, just .sql files added to the shared dbt project.
    "dbt-runner",
  ]

  # Residency footprints. Must match cloudComputeRegionForResidency()
  # in src/lib/gcp.ts — adding a new residency tier means changes in
  # both places.
  residency_regions = {
    eu = "europe-west1"
    us = "us-central1"
  }

  # Cartesian product: every connector × every residency region, keyed
  # by `<connector>-<suffix>` so each job has a unique resource address.
  connector_jobs = merge([
    for suffix, region in local.residency_regions : {
      for ct in local.connector_types :
      "${ct}-${suffix}" => {
        connector_type = ct
        region         = region
        suffix         = suffix
      }
    }
  ]...)
}

resource "google_cloud_run_v2_job" "connector" {
  for_each = local.connector_jobs

  name     = "connector-${each.key}"
  location = each.value.region
  project  = var.project_id

  # Cloud Run v2 Jobs default to deletion_protection=true. That blocked
  # PR #89's amplitude-revert apply with "cannot destroy job without
  # setting deletion_protection=false" — and would block ANY future
  # connector removal the same way.
  #
  # Setting `false` here means: when a connector is removed from
  # local.connector_types, Terraform updates the attribute on each
  # existing Job FIRST (turning off protection), THEN runs the destroy
  # — all in one apply. Standard Terraform ordering: attribute updates
  # before destroys.
  #
  # Risk: a typo in connector_types could silently destroy a live Job.
  # Mitigation: connector_types changes always go via PR + reviewed
  # `terraform plan` output, which shows the destroy intent explicitly.
  # The plan-on-PR comment workflow (Terraform CI) surfaces it.
  deletion_protection = false

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

  labels = merge(local.common_labels, {
    residency = each.value.suffix
  })

  depends_on = [
    google_project_service.enabled,
    google_artifact_registry_repository.connectors,
  ]

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}
