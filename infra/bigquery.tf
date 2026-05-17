# Per-workspace datasets are created by the app at runtime when a workspace
# adds its first connector. This file declares the shared metadata dataset
# the agent uses for cross-workspace lookups (e.g. cached schema introspection).

resource "google_bigquery_dataset" "agent_metadata" {
  dataset_id  = "liveli_agent_metadata"
  friendly_name = "Liveli — Agent metadata"
  description = "Cached schema introspection, query plans, and tool execution history. Not customer data."
  location    = var.bq_location

  labels = local.common_labels

  depends_on = [google_project_service.enabled]
}
