# Liveli infra (Terraform)

Manages all GCP resources for `liveli-496609`. Applied by CI on push to `main`; can be applied locally with the same service account by an operator with `iam.workloadIdentityUser` impersonation rights.

## One-time bootstrap

```bash
chmod +x bootstrap.sh
./bootstrap.sh liveli-496609
```

Creates the GCS bucket `liveli-tf-state-eu` for remote state. Idempotent.

## Apply locally

```bash
terraform init
terraform plan
terraform apply
```

## Apply via CI

Push to `main` with changes under `infra/**`. The `terraform.yml` workflow runs `plan` on PRs (comments the plan on the PR), and `apply` on merge.

## Region map

| Resource | Region |
|---|---|
| Firestore | `eur3` (multi-region NL + BE) |
| BigQuery | `EU` (multi-region) |
| GCS | `EU` (multi-region) |
| Cloud Run / Artifact Registry / Secret Manager | `europe-west4` |
| Vertex AI (Claude) | `us-central1` *(only region with the full latest Claude family)* |

## Outputs to wire into CI/CD

After first apply:

```bash
terraform output -json | jq
```

Copy these values:
- `github_wif_provider` → GitHub repo variable `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `ci_service_account_email` → GitHub repo variable `GCP_CI_SERVICE_ACCOUNT`
- `runtime_service_account_email` → Vercel env `GCP_RUNTIME_SERVICE_ACCOUNT`
- `vercel_wif_audience` → Vercel env `GCP_WORKLOAD_IDENTITY_PROVIDER`

## What's intentionally NOT here

- **Per-workspace BigQuery datasets** — created by the app at runtime when a workspace adds its first connector
- **Connector secrets in Secret Manager** — created by the app when a user pastes credentials
- **Connector Docker images** — built and published by `.github/workflows/deploy-connectors.yml`
