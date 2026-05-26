# ============================================================================
# Liveli — GCP monthly billing cap with automated kill-switch
# ----------------------------------------------------------------------------
# When monthly NET spend on `target_project_id` reaches `budget_amount_gbp`,
# a Pub/Sub-triggered Cloud Function (gen 2, Python 3.12) calls Cloud Billing's
# updateBillingInfo() to disassociate the project from its billing account —
# stopping all further charges within minutes.
#
# Two-project layout: the Cloud Function lives in a SEPARATE project so that
# disabling billing on the target does not kill the function itself. This
# is enforced by a precondition guard that fails `terraform plan` if the two
# project IDs are equal.
#
# Adapted from: https://cloud.google.com/billing/docs/how-to/notify
# ============================================================================

locals {
  # Merged label set — common labels for every Liveli-managed resource plus
  # caller-provided extras. Mirrors the convention in infra/locals.tf.
  common_labels = merge(
    {
      product    = "liveli"
      managed_by = "terraform"
      repo       = "jay-nexusascent-liveli"
      module     = "billing-cap"
    },
    var.labels,
  )

  # APIs required in the killswitch project (where the function and its
  # support resources live). Cloud Functions gen 2 sits on top of Cloud Run
  # and Eventarc — both must be enabled for the Pub/Sub trigger to wire up.
  killswitch_apis = [
    "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudfunctions.googleapis.com",
    "pubsub.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "eventarc.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
  ]

  # APIs required in the target project. The function calls these against
  # the target on behalf of the runtime SA.
  target_apis = [
    "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com",
  ]
}

# ============================================================================
# Precondition guard — refuse to apply if the two projects are the same
# ----------------------------------------------------------------------------
# This is the most consequential check in the whole module. If the user
# accidentally points target_project_id and killswitch_project_id at the
# same project, disabling billing during a real fire would kill the function
# mid-execution, leaving the project half-disabled. Fail loudly at plan time.
# ============================================================================
resource "terraform_data" "guard_two_project" {
  input = {
    target     = var.target_project_id
    killswitch = var.killswitch_project_id
  }

  lifecycle {
    precondition {
      condition     = var.killswitch_project_id != var.target_project_id
      error_message = "killswitch_project_id (${var.killswitch_project_id}) MUST differ from target_project_id (${var.target_project_id}). Hosting the Cloud Function in the same project it disables billing on would kill the function mid-execution. Create a separate GCP project for the kill-switch before applying."
    }
  }
}

# ============================================================================
# Required APIs
# ============================================================================
resource "google_project_service" "killswitch" {
  for_each = var.enable_apis ? toset(local.killswitch_apis) : toset([])

  provider = google.killswitch
  project  = var.killswitch_project_id
  service  = each.value

  # Keep services enabled even on `terraform destroy` so a re-apply doesn't
  # have to wait for API propagation again. Disabling APIs on destroy is
  # rarely what you want.
  disable_on_destroy = false
}

resource "google_project_service" "target" {
  for_each = var.enable_apis ? toset(local.target_apis) : toset([])

  provider = google.target
  project  = var.target_project_id
  service  = each.value

  disable_on_destroy = false
}

# ============================================================================
# Pub/Sub topic — receives budget notifications
# ----------------------------------------------------------------------------
# The Cloud Billing service agent on the billing account is auto-granted
# roles/pubsub.publisher on this topic when the budget's all_updates_rule
# references it. Verified via:
#
#   gcloud pubsub topics get-iam-policy gcp-billing-alert \
#     --project=<killswitch_project_id>
#
# You should see a member like
#   serviceAccount:billing-budgets@system.gserviceaccount.com
# with role roles/pubsub.publisher. No explicit grant needed in this module.
# ============================================================================
resource "google_pubsub_topic" "budget_alerts" {
  provider = google.killswitch
  project  = var.killswitch_project_id
  name     = "gcp-billing-alert"

  labels = local.common_labels

  depends_on = [google_project_service.killswitch]
}

# ============================================================================
# Service account for the Cloud Function runtime
# ============================================================================
resource "google_service_account" "killswitch_runtime" {
  provider = google.killswitch
  project  = var.killswitch_project_id

  account_id   = "billing-killswitch-runtime"
  display_name = "Billing kill-switch Cloud Function runtime"
  description  = "Runtime identity for the gen-2 Cloud Function that disables billing on ${var.target_project_id} when the monthly cap fires."

  depends_on = [google_project_service.killswitch]
}

# Function SA → roles/billing.projectManager on the TARGET project.
# This is the role that grants the updateBillingInfo() permission.
resource "google_project_iam_member" "runtime_billing_project_manager" {
  provider = google.target
  project  = var.target_project_id
  role     = "roles/billing.projectManager"
  member   = "serviceAccount:${google_service_account.killswitch_runtime.email}"
}

# Function SA → roles/billing.user on the BILLING ACCOUNT.
# Needed to read budget metadata when responding to notifications.
resource "google_billing_account_iam_member" "runtime_billing_user" {
  billing_account_id = var.billing_account_id
  role               = "roles/billing.user"
  member             = "serviceAccount:${google_service_account.killswitch_runtime.email}"
}

# Function SA → roles/eventarc.eventReceiver on the killswitch project.
# Required for gen-2 functions triggered by Eventarc (the Pub/Sub trigger
# under the hood is an Eventarc subscription, not a direct Pub/Sub push).
resource "google_project_iam_member" "runtime_eventarc_receiver" {
  provider = google.killswitch
  project  = var.killswitch_project_id
  role     = "roles/eventarc.eventReceiver"
  member   = "serviceAccount:${google_service_account.killswitch_runtime.email}"
}

# Function SA → roles/run.invoker on the killswitch project.
# Gen-2 functions are Cloud Run services under the hood, the invoker role
# is what lets the Eventarc trigger actually invoke the function.
resource "google_project_iam_member" "runtime_run_invoker" {
  provider = google.killswitch
  project  = var.killswitch_project_id
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.killswitch_runtime.email}"
}

# ============================================================================
# Function source — zip locally via archive_file, upload to GCS
# ============================================================================
resource "google_storage_bucket" "function_source" {
  provider = google.killswitch
  project  = var.killswitch_project_id

  name                        = "${var.killswitch_project_id}-billing-cap-fn-source"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true # source bucket is reproducible — safe to nuke

  labels = local.common_labels

  depends_on = [google_project_service.killswitch]
}

data "archive_file" "function_source" {
  type        = "zip"
  source_dir  = "${path.module}/functions/disable_billing"
  output_path = "${path.module}/.terraform/tmp/disable_billing.zip"
}

resource "google_storage_bucket_object" "function_source" {
  provider = google.killswitch

  # Include the content hash in the object name so updates to the source
  # zip force the Cloud Function resource to redeploy. Without this, Terraform
  # won't notice source changes and your code edits silently don't deploy.
  name   = "disable_billing-${data.archive_file.function_source.output_md5}.zip"
  bucket = google_storage_bucket.function_source.name
  source = data.archive_file.function_source.output_path
}

# ============================================================================
# Cloud Function (gen 2, Python 3.12) — the kill-switch itself
# ============================================================================
resource "google_cloudfunctions2_function" "disable_billing" {
  provider = google.killswitch
  project  = var.killswitch_project_id
  location = var.region

  name        = "disable-billing-killswitch"
  description = "Disables billing on ${var.target_project_id} when monthly spend cap is hit. Triggered by Pub/Sub messages on ${google_pubsub_topic.budget_alerts.name}."

  build_config {
    runtime     = var.function_runtime
    entry_point = "stop_billing"

    source {
      storage_source {
        bucket = google_storage_bucket.function_source.name
        object = google_storage_bucket_object.function_source.name
      }
    }
  }

  service_config {
    max_instance_count    = 3 # one at a time is enough; keep some headroom
    min_instance_count    = 0
    available_memory      = "256Mi"
    timeout_seconds       = 60
    service_account_email = google_service_account.killswitch_runtime.email

    environment_variables = {
      TARGET_PROJECT_ID = var.target_project_id
      DRY_RUN           = var.dry_run ? "true" : "false"
    }
  }

  event_trigger {
    trigger_region = var.region
    event_type     = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic   = google_pubsub_topic.budget_alerts.id
    retry_policy   = "RETRY_POLICY_RETRY" # at-least-once, idempotent function
  }

  labels = local.common_labels

  depends_on = [
    google_project_service.killswitch,
    google_project_iam_member.runtime_eventarc_receiver,
    google_project_iam_member.runtime_run_invoker,
    google_project_iam_member.runtime_billing_project_manager,
    google_billing_account_iam_member.runtime_billing_user,
  ]
}

# ============================================================================
# Notification channels
# ----------------------------------------------------------------------------
# Email channels: one per recipient. Attached directly to the budget's
# all_updates_rule.monitoring_notification_channels — emails fire on every
# threshold without going through an alerting policy (lower latency).
#
# Mobile channel: looked up via data source (must already exist — created
# when the user registers a device in the Google Cloud mobile app). Attached
# to the alerting policy below, not the budget.
# ============================================================================
resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.email_recipients)

  provider     = google.killswitch
  project      = var.killswitch_project_id
  display_name = "Billing cap email — ${each.value}"
  type         = "email"

  labels = {
    email_address = each.value
  }

  user_labels = local.common_labels

  depends_on = [google_project_service.killswitch]
}

data "google_monitoring_notification_channel" "mobile" {
  provider     = google.killswitch
  project      = var.killswitch_project_id
  display_name = var.mobile_channel_display_name
  type         = "google_cloud_monitoring_mobile"

  depends_on = [google_project_service.killswitch]
}

# ============================================================================
# Log-based metric — counts "threshold_crossed" entries from the function
# ----------------------------------------------------------------------------
# The function emits a structured log entry with severity=WARNING and a
# json_payload field threshold_crossed=true every time a budget threshold
# is exceeded. This metric counts those entries with a `threshold` label
# so the alerting policy below can route to mobile + email.
#
# Why not a metric on the Pub/Sub topic message count? The budget publishes
# messages on EVERY spend change, not just threshold crossings — alerting
# on raw topic activity would produce spam. The function does the
# threshold-crossed filtering, the metric just counts what the function
# decides is alert-worthy.
# ============================================================================
resource "google_logging_metric" "threshold_crossed" {
  provider = google.killswitch
  project  = var.killswitch_project_id

  name = "billing_cap_threshold_crossed"

  filter = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${google_cloudfunctions2_function.disable_billing.name}"
    severity>=WARNING
    jsonPayload.threshold_crossed="true"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "threshold"
      value_type  = "STRING"
      description = "Fraction of budget that was crossed (e.g. 0.25, 0.5, 1.0)."
    }
  }

  label_extractors = {
    "threshold" = "EXTRACT(jsonPayload.threshold)"
  }
}

# ============================================================================
# Alerting policy — fires mobile + email push at every threshold crossing
# ============================================================================
resource "google_monitoring_alert_policy" "threshold_alerts" {
  provider = google.killswitch
  project  = var.killswitch_project_id

  display_name = "Liveli billing cap — threshold crossed"
  combiner     = "OR"

  conditions {
    display_name = "Budget threshold crossed"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.threshold_crossed.name}\" resource.type=\"cloud_run_revision\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.threshold"]
      }
    }
  }

  notification_channels = concat(
    [data.google_monitoring_notification_channel.mobile.name],
    [for c in google_monitoring_notification_channel.email : c.name],
  )

  alert_strategy {
    auto_close = "1800s" # auto-close after 30min — these are events not states
  }

  documentation {
    content   = <<-EOT
      A monthly-budget threshold was crossed on `${var.target_project_id}`.

      Check the function logs for cost/budget detail:
      https://console.cloud.google.com/functions/details/${var.region}/${google_cloudfunctions2_function.disable_billing.name}?project=${var.killswitch_project_id}

      If the threshold is 1.0 (100%), the kill-switch has already fired and
      billing has been disabled on `${var.target_project_id}`. To restore service,
      manually re-link the billing account in the GCP console.
    EOT
    mime_type = "text/markdown"
  }

  user_labels = local.common_labels
}

# ============================================================================
# Function health alert — "the kill-switch's own kill-switch"
# ----------------------------------------------------------------------------
# Fires if the Cloud Function errors out or has invocation failures. Catches
# the scenarios where the kill-switch SHOULD have stopped spend but didn't:
#   - IAM mis-config (updateBillingInfo returns 403)
#   - Function-side bug (crash on malformed message, logic error)
#   - Cloud Billing API degradation
#
# Without this, you'd only notice when the bill arrives. With it, you get a
# notification BEFORE the bill arrives so you can manually intervene.
# ============================================================================
resource "google_logging_metric" "function_errors" {
  provider = google.killswitch
  project  = var.killswitch_project_id

  name = "billing_cap_function_errors"

  filter = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${google_cloudfunctions2_function.disable_billing.name}"
    severity>=ERROR
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "function_health" {
  provider = google.killswitch
  project  = var.killswitch_project_id

  display_name = "Liveli billing cap — kill-switch function failing"
  combiner     = "OR"

  conditions {
    display_name = "Kill-switch function logged ERROR"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.function_errors.name}\" resource.type=\"cloud_run_revision\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_DELTA"
      }
    }
  }

  notification_channels = concat(
    [data.google_monitoring_notification_channel.mobile.name],
    [for c in google_monitoring_notification_channel.email : c.name],
  )

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = <<-EOT
      The billing-cap kill-switch function on `${var.killswitch_project_id}`
      logged at ERROR severity. This means a budget notification arrived
      but the function failed to act on it — billing on
      `${var.target_project_id}` may NOT have been disabled despite
      the budget being exceeded.

      Investigate immediately:
      https://console.cloud.google.com/functions/details/${var.region}/${google_cloudfunctions2_function.disable_billing.name}?project=${var.killswitch_project_id}

      Common causes:
      - IAM: function SA missing roles/billing.projectManager on target
      - IAM: function SA missing roles/billing.user on billing account
      - Malformed budget message (rare — file a GCP support ticket)
    EOT
    mime_type = "text/markdown"
  }

  user_labels = local.common_labels
}

# ============================================================================
# The budget itself — last because everything else has to exist first
# ============================================================================
resource "google_billing_budget" "monthly_cap" {
  billing_account = var.billing_account_id
  display_name    = "Liveli ${var.target_project_id} — £${var.budget_amount_gbp}/month cap with kill-switch"

  budget_filter {
    projects = ["projects/${var.target_project_id}"]

    # NET spend — credits (free trials, sustained-use discounts, promotional
    # credits) offset the bill before the threshold is calculated. The cap
    # fires on the amount you actually pay, not the gross amount.
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = var.budget_amount_gbp
    }
  }

  dynamic "threshold_rules" {
    for_each = var.thresholds
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND" # actual spend, not forecasted
    }
  }

  all_updates_rule {
    pubsub_topic                     = google_pubsub_topic.budget_alerts.id
    disable_default_iam_recipients   = false # keep default billing-admin emails
    monitoring_notification_channels = [for c in google_monitoring_notification_channel.email : c.id]
  }

  depends_on = [
    google_project_service.target,
    google_project_service.killswitch,
    google_billing_account_iam_member.runtime_billing_user,
  ]
}
