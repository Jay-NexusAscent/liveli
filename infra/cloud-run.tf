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
