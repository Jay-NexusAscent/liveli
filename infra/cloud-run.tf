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
    "sqlserver-to-bq",
    "redshift-to-bq",
    "synapse-to-bq",
    "bigquery-to-bq",
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
    # amplitude-to-bq — REMOVED. The singer-io variant of tap-amplitude
    # was de-registered from the Meltano Hub, and the remaining
    # `airbyte` variant requires Docker-in-Docker (Cloud Run Jobs can't
    # provide that runtime). No suitable replacement tap exists today.
    # Tracked in LIVELI-135 for re-enable when either a viable singer
    # tap surfaces or we build a custom one against Amplitude's Export
    # API. Connector dir + wizard + connect route already removed in
    # PR #89; this PR completes the cleanup by removing the Cloud Run
    # Job templates from Terraform's for_each map, which destroys the
    # two orphan placeholder Jobs. The two-step apply pattern (PR #96
    # set deletion_protection=false first; this PR does the destroy)
    # was required because Terraform's destroy plan doesn't include
    # attribute updates — see PR #96's description for the full
    # rationale if needed.
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

# ── Metadata enrichment agent jobs ────────────────────────────────
# One per residency region (europe-west1 / us-central1), same EU/US
# suffix scheme as the connector jobs so the dispatcher can build the
# name from cloudComputeRegionForResidency(workspace.bqLocation).
#
# Unlike the Meltano connectors (Python images), this is a Node image
# that runs the TypeScript metadata agent (scripts/metadata-agent-job).
# Per-invocation context (CLIENT_ID, WORKSPACE_ID, CONNECTOR_ID,
# CONNECTOR_TYPE, BQ_DATASET, BQ_LOCATION) is injected as env overrides
# at run time by the dispatcher in src/lib/metadata/dispatcher.ts.
#
# Runs as liveli-agent-metadata — the least-privileged SA. The SA
# attaches natively here (metadata server provides creds via ADC), so
# the agent needs no impersonation code; ensureGcpAuth() no-ops off
# Vercel and the SDKs discover the attached SA automatically.
#
# 900s timeout: with MAX_TURNS=150 in agent.ts a full-schema run can
# take several minutes — comfortably beyond the 300s Vercel function
# ceiling the old after() path was capped at. This is the core reason
# for the migration.
resource "google_cloud_run_v2_job" "metadata_agent" {
  for_each = local.residency_regions

  name     = "metadata-agent-${each.key}"
  location = each.value
  project  = var.project_id

  # Same rationale as the connector jobs — allows Terraform to remove
  # the job later without a two-step protection-disable apply.
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.metadata_agent.email
      max_retries     = 1
      timeout         = "900s"

      containers {
        # Placeholder — replaced by the deploy-metadata-agent workflow.
        image = "us-docker.pkg.dev/cloudrun/container/hello"

        # Static, project-wide env. Per-invocation context (CLIENT_ID,
        # WORKSPACE_ID, etc.) is injected as overrides by the dispatcher.
        # No VERCEL var — ensureGcpAuth() keys off its absence to skip
        # the OIDC path and use the natively attached SA via ADC.
        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        # Pin the metadata agent to Gemini Flash. LIVELI-107 switched
        # gcp.vertexModel's global default to claude-sonnet-4-6 for the
        # chat agent's quality, but the metadata agent's job is simpler
        # (one-sentence column descriptions from samples) and runs in
        # europe-west1 where Sonnet isn't enabled in this project's
        # Model Garden. Flash is fit-for-purpose and ~10× cheaper here.
        env {
          name  = "VERTEX_AI_MODEL"
          value = "gemini-2.5-flash"
        }

        resources {
          limits = {
            # I/O-bound (waits on Vertex + BQ); modest compute is fine.
            cpu    = "1"
            memory = "2Gi"
          }
        }
      }
    }
  }

  labels = merge(local.common_labels, {
    residency = each.key
  })

  depends_on = [
    google_project_service.enabled,
    google_artifact_registry_repository.connectors,
    google_service_account.metadata_agent,
  ]

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}
