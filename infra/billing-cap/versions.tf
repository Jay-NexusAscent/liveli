terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.10"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Same backend bucket as the main infra module, but a separate state
  # prefix so this module can be applied/destroyed independently. That
  # isolation is the whole point of a kill-switch: changes to it must
  # never require touching the main infra state.
  backend "gcs" {
    bucket = "liveli-tf-state-eu"
    prefix = "infra/billing-cap/state"
  }
}

# Two provider aliases — one for each project. Resources in this module
# explicitly select which project they target via `provider = google.target`
# or `provider = google.killswitch`. This is clearer than passing
# `project = var.xxx_project_id` on every resource and prevents the easy
# mistake of accidentally creating something in the wrong project.

provider "google" {
  alias   = "target"
  project = var.target_project_id
  region  = var.region
}

provider "google" {
  alias   = "killswitch"
  project = var.killswitch_project_id
  region  = var.region
}
