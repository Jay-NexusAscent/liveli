# Per-workspace datasets are created by the app at runtime when a workspace
# adds its first connector. This file declares the shared metadata dataset
# the agent uses for cross-workspace lookups (e.g. cached schema introspection).

resource "google_bigquery_dataset" "agent_metadata" {
  dataset_id    = "liveli_agent_metadata"
  friendly_name = "Liveli — Agent metadata"
  description   = "Cached schema introspection, query plans, and tool execution history. Not customer data."
  location      = var.bq_location

  labels = local.common_labels

  depends_on = [google_project_service.enabled]
}

# ─────────────────────────────────────────────────────────────────────
# Internal usage tracking dataset. Holds the append-only event stream
# (usage_events) and the daily rollup (usage_daily). Powers:
#   - In-app billing UI ("today you've used £X")
#   - Plan-limit enforcement
#   - Vertex AI cost attribution (no labels available, we log directly)
#
# Lives in EU multi-region — same residency as customer data.
# Customers never see this. The runtime SA writes; only internal
# tooling reads. Not exported via Billing Export; this is OUR ledger.

resource "google_bigquery_dataset" "internal" {
  dataset_id    = "liveli_internal"
  friendly_name = "Liveli — Internal usage tracking"
  description   = "Append-only event stream + daily cost rollups. Powers in-app billing UI. NOT customer data."
  location      = var.bq_location

  labels = local.common_labels

  depends_on = [google_project_service.enabled]
}

# Append-only event stream. Every billable operation lands here via
# fire-and-forget streaming insert from the runtime. Partitioned by day
# (queries usually want "yesterday" or "this month"); clustered by
# clientId for fast per-tenant filtering.

resource "google_bigquery_table" "usage_events" {
  dataset_id = google_bigquery_dataset.internal.dataset_id
  table_id   = "usage_events"

  time_partitioning {
    type  = "DAY"
    field = "ts"
  }

  clustering = ["clientId", "eventType"]

  # Schema columns are intentionally a superset — different event types
  # populate different subsets. The labels JSON column is the escape
  # hatch for future event types that need extra fields without a
  # schema migration.
  schema = jsonencode([
    { name = "ts", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "clientId", type = "STRING", mode = "REQUIRED" },
    { name = "workspaceId", type = "STRING", mode = "NULLABLE" },
    { name = "userId", type = "STRING", mode = "NULLABLE" },
    { name = "eventType", type = "STRING", mode = "REQUIRED" },
    { name = "resource", type = "STRING", mode = "NULLABLE" },
    { name = "bytesScanned", type = "INT64", mode = "NULLABLE" },
    { name = "executionMs", type = "INT64", mode = "NULLABLE" },
    { name = "model", type = "STRING", mode = "NULLABLE" },
    { name = "tokensIn", type = "INT64", mode = "NULLABLE" },
    { name = "tokensOut", type = "INT64", mode = "NULLABLE" },
    { name = "cost_gbp_estimate", type = "FLOAT64", mode = "NULLABLE" },
    { name = "labels", type = "JSON", mode = "NULLABLE" },
  ])

  labels = local.common_labels

  # Don't fight the schema if it drifts via SDK writes — Terraform
  # owns the canonical definition but auto-resolves on apply.
  lifecycle {
    ignore_changes = []
  }
}

# Daily rollup. Populated by a scheduled query (see commit 11 of the
# architecture migration — Phase 2 territory).

resource "google_bigquery_table" "usage_daily" {
  dataset_id = google_bigquery_dataset.internal.dataset_id
  table_id   = "usage_daily"

  time_partitioning {
    type  = "DAY"
    field = "date"
  }

  clustering = ["clientId"]

  schema = jsonencode([
    { name = "date", type = "DATE", mode = "REQUIRED" },
    { name = "clientId", type = "STRING", mode = "REQUIRED" },
    { name = "queries_count", type = "INT64", mode = "NULLABLE" },
    { name = "bytes_scanned_total", type = "INT64", mode = "NULLABLE" },
    { name = "agent_calls_count", type = "INT64", mode = "NULLABLE" },
    { name = "tokens_in_total", type = "INT64", mode = "NULLABLE" },
    { name = "tokens_out_total", type = "INT64", mode = "NULLABLE" },
    { name = "cost_bigquery_gbp", type = "FLOAT64", mode = "NULLABLE" },
    { name = "cost_cloudrun_gbp", type = "FLOAT64", mode = "NULLABLE" },
    { name = "cost_vertex_gbp", type = "FLOAT64", mode = "NULLABLE" },
    { name = "cost_total_gbp", type = "FLOAT64", mode = "NULLABLE" },
  ])

  labels = local.common_labels
}
