locals {
  # Shared labels applied to every resource that supports them.
  common_labels = {
    product    = "liveli"
    managed_by = "terraform"
    repo       = "jay-nexusascent-liveli"
  }
}
