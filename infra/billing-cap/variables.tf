variable "billing_account_id" {
  description = "GCP billing account ID (format: XXXXXX-XXXXXX-XXXXXX). The budget is attached to this account. Default is Liveli's primary billing account — not sensitive (these IDs are non-secret identifiers like project IDs)."
  type        = string
  default     = "01E8DE-46C3B1-7FEAA9"

  validation {
    # Allow 0-9 A-Z to match Google's full alphanumeric format (not just hex).
    condition     = can(regex("^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$", var.billing_account_id))
    error_message = "billing_account_id must be in the format XXXXXX-XXXXXX-XXXXXX (uppercase alphanumeric)."
  }
}

variable "target_project_id" {
  description = "Project the budget watches AND the project that gets its billing disabled when the cap fires. Default matches Liveli's main GCP project per infra/variables.tf."
  type        = string
  default     = "liveli-496609"
}

variable "killswitch_project_id" {
  description = "Host project for the Cloud Function. MUST differ from target_project_id — if equal, disabling billing would kill the function mid-execution. Enforced by a precondition guard at plan time."
  type        = string
  default     = "liveli-killswitch"
}

variable "budget_amount_gbp" {
  description = "Monthly budget cap in GBP. The function disables billing on target_project_id when actual NET spend (after credits) reaches this amount."
  type        = number
  default     = 500

  validation {
    condition     = var.budget_amount_gbp > 0
    error_message = "budget_amount_gbp must be positive."
  }
}

variable "budget_currency" {
  description = "Currency code for the budget. Must match the currency of the billing account."
  type        = string
  default     = "GBP"
}

variable "thresholds" {
  description = "Fractions of the budget at which to send notifications. Each crossing triggers a Pub/Sub message, an email (via default IAM and explicit channels), and a mobile push (via alerting policy)."
  type        = list(number)
  default     = [0.25, 0.5, 0.75, 0.8, 0.9, 1.0]

  validation {
    condition     = alltrue([for t in var.thresholds : t > 0 && t <= 1.0])
    error_message = "All thresholds must be in (0, 1.0]."
  }
}

variable "email_recipients" {
  description = "Email addresses to attach to the budget as monitoring notification channels. These get notifications at every threshold in addition to the default billing-admin IAM recipients (which are NOT disabled)."
  type        = list(string)
  default     = ["support@liveli.ai", "jay@liveli.ai"]

  validation {
    condition     = length(var.email_recipients) > 0
    error_message = "At least one email recipient is required."
  }
}

variable "mobile_channel_name" {
  description = "FULL resource name of an existing Cloud Monitoring mobile push channel, e.g. projects/liveli-496609/notificationChannels/1234567890123456789. NOT the display name — user-scoped mobile channels (the kind the GCP mobile app registers) are not returned by project-scoped data-source lookups, so we reference by resource name directly. Set to empty string to disable mobile push (kill-switch still works via email). Find the resource name in the Console under Monitoring → Alerting → Edit notification channels → Mobile Devices → click the channel."
  type        = string
  default     = ""

  validation {
    condition     = var.mobile_channel_name == "" || can(regex("^projects/[^/]+/notificationChannels/[0-9]+$", var.mobile_channel_name))
    error_message = "mobile_channel_name must be empty or a full resource path: projects/<project>/notificationChannels/<numeric-id>."
  }
}

variable "region" {
  description = "GCP region for the Cloud Function and storage bucket. Matches Liveli's europe-west4 convention for Cloud Run / Artifact Registry / Secret Manager."
  type        = string
  default     = "europe-west4"
}

variable "function_runtime" {
  description = "Cloud Functions gen 2 runtime. Pinned to Python 3.12 per the spec."
  type        = string
  default     = "python312"
}

variable "enable_apis" {
  description = "If true, this module enables the required GCP APIs in both projects. Set to false if APIs are already enabled by another Terraform module to avoid duplicate management."
  type        = bool
  default     = true
}

variable "dry_run" {
  description = "If true, the Cloud Function logs what it WOULD do but does not actually call updateBillingInfo. Currently defaults to TRUE so the first deployment is testable end-to-end without risk of disabling billing for real. After verifying mobile push + email notifications arrive on a synthetic test message AND the function logs `DRY_RUN mode — would have disabled but skipping`, flip this default to false in a follow-up PR to arm the kill-switch for production. MUST be false for the kill-switch to actually disable billing."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Additional labels applied to resources that support them. Merged with the module's built-in labels."
  type        = map(string)
  default     = {}
}
