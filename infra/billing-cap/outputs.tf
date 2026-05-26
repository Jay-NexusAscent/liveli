output "pubsub_topic_id" {
  description = "Fully-qualified ID of the Pub/Sub topic the budget publishes to. Use for synthetic-message testing: `gcloud pubsub topics publish \"$(terraform output -raw pubsub_topic_id)\" --message=...`"
  value       = google_pubsub_topic.budget_alerts.id
}

output "pubsub_topic_name" {
  description = "Short name of the Pub/Sub topic (without the projects/.../topics/ prefix)."
  value       = google_pubsub_topic.budget_alerts.name
}

output "function_name" {
  description = "Cloud Function name. Use with `gcloud functions describe` or `gcloud functions delete` for emergency removal."
  value       = google_cloudfunctions2_function.disable_billing.name
}

output "function_sa_email" {
  description = "Email identifier (NOT a mailbox) of the function's runtime service account. Use with `gcloud projects get-iam-policy <target> --filter=\"bindings.members:<sa>\"` to verify required roles."
  value       = google_service_account.killswitch_runtime.email
}

output "function_logs_url" {
  description = "Deeplink to the function's logs in Cloud Logging. Bookmark this — first place to check after a budget alert."
  value       = "https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%20resource.labels.service_name%3D%22${google_cloudfunctions2_function.disable_billing.name}%22?project=${var.killswitch_project_id}"
}

output "budget_id" {
  description = "Resource ID of the billing budget. Use with `gcloud billing budgets describe <id> --billing-account=<billing-account-id>` to inspect from the CLI."
  value       = google_billing_budget.monthly_cap.id
}

output "function_health_alert_id" {
  description = "ID of the alerting policy that fires if the kill-switch function itself errors. The kill-switch's own kill-switch."
  value       = google_monitoring_alert_policy.function_health.id
}

output "threshold_alert_id" {
  description = "ID of the alerting policy that routes threshold-crossed notifications to mobile + email."
  value       = google_monitoring_alert_policy.threshold_alerts.id
}
