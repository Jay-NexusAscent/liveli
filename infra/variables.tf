variable "project_id" {
  description = "GCP project ID hosting Liveli."
  type        = string
  default     = "liveli-496609"
}

variable "gcp_region" {
  description = "Default GCP region for single-region resources (Cloud Run, Artifact Registry, Secret Manager)."
  type        = string
  default     = "europe-west4"
}

variable "bq_location" {
  description = "BigQuery multi-region location."
  type        = string
  default     = "EU"
}

variable "gcs_location" {
  description = "GCS multi-region location."
  type        = string
  default     = "EU"
}

variable "firestore_location" {
  description = "Firestore multi-region location."
  type        = string
  default     = "eur3"
}

variable "vertex_region" {
  description = "Vertex AI region (only us-central1 has the full latest Claude family as of 2026)."
  type        = string
  default     = "us-central1"
}

variable "github_repo" {
  description = "GitHub repo in owner/name form, used for Workload Identity Federation principal binding."
  type        = string
  default     = "Jay-NexusAscent/liveli"
}

variable "vercel_team_slug" {
  description = "Vercel team slug, used for the Vercel OIDC issuer configuration."
  type        = string
  default     = "james-4347s-projects"
}
