# One-shot import of the metadata-agent resources that were created
# out-of-band (by hand) before being codified in iam.tf + cloud-run.tf.
#
# These `import` blocks let `terraform apply` adopt the existing live
# resources into state instead of trying to CREATE them (which would
# 409 "already exists" and fail the whole apply). The CI workflow runs
# `terraform apply -auto-approve` on merge to main, so the import
# happens there automatically — no manual `terraform import` step.
#
# SAFE TO DELETE this file after the first successful apply on main:
# once the resources are in state, these blocks are no-ops. Left in
# place they stay idempotent (Terraform skips already-imported targets).

import {
  to = google_service_account.agent_metadata
  id = "projects/${var.project_id}/serviceAccounts/liveli-agent-metadata@${var.project_id}.iam.gserviceaccount.com"
}

import {
  to = google_project_iam_custom_role.metadata_agent_bq
  id = "projects/${var.project_id}/roles/liveliMetadataAgentBq"
}

import {
  to = google_project_iam_member.agent_metadata["roles/aiplatform.user"]
  id = "${var.project_id} roles/aiplatform.user serviceAccount:liveli-agent-metadata@${var.project_id}.iam.gserviceaccount.com"
}

import {
  to = google_project_iam_member.agent_metadata["roles/datastore.user"]
  id = "${var.project_id} roles/datastore.user serviceAccount:liveli-agent-metadata@${var.project_id}.iam.gserviceaccount.com"
}

import {
  to = google_project_iam_member.agent_metadata["projects/${var.project_id}/roles/liveliMetadataAgentBq"]
  id = "${var.project_id} projects/${var.project_id}/roles/liveliMetadataAgentBq serviceAccount:liveli-agent-metadata@${var.project_id}.iam.gserviceaccount.com"
}

import {
  to = google_cloud_run_v2_job.metadata_agent["eu"]
  id = "projects/${var.project_id}/locations/europe-west1/jobs/metadata-agent-eu"
}

import {
  to = google_cloud_run_v2_job.metadata_agent["us"]
  id = "projects/${var.project_id}/locations/us-central1/jobs/metadata-agent-us"
}
