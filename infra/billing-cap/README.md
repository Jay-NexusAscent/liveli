# GCP billing cap with automated kill-switch

Terraform module that implements a **hard monthly spend cap** on a GCP project. When monthly NET spend (after credits) hits the configured amount, a Cloud Function automatically disables billing on the project — stopping essentially all charges within minutes.

Designed to be a "circuit breaker for the company": you'd rather have a service outage than an unbounded bill.

## Architecture

```
                            ┌──────────────────────────────────┐
                            │  BILLING ACCOUNT                 │
                            │  google_billing_budget           │
                            │    £500/month, 6 thresholds,     │
                            │    INCLUDE_ALL_CREDITS           │
                            └─────────────────┬────────────────┘
                                              │
                                              │  publishes notification
                                              │  at every threshold cross
                                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  KILLSWITCH PROJECT  (host — separate from target)                       │
│                                                                          │
│   google_pubsub_topic.budget_alerts                                      │
│            │                                                             │
│            │  triggers (via Eventarc)                                    │
│            ▼                                                             │
│   google_cloudfunctions2_function.disable_billing  (Python 3.12, gen 2)  │
│            │                                                             │
│            │  if cost >= budget AND not already disabled                 │
│            │  AND not DRY_RUN                                            │
│            ▼                                                             │
│            ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─           │
│                                                                          │
│   google_logging_metric.threshold_crossed                                │
│      └─► google_monitoring_alert_policy.threshold_alerts                 │
│                ├─► mobile push (data source lookup)                      │
│                └─► email channels (one per recipient)                    │
│                                                                          │
│   google_logging_metric.function_errors                                  │
│      └─► google_monitoring_alert_policy.function_health                  │
│           "The kill-switch's own kill-switch"                            │
│                ├─► mobile push                                           │
│                └─► email channels                                        │
└──────────────────────────────────────────────┬───────────────────────────┘
                                               │
                                               │  calls Cloud Billing API:
                                               │  projects.updateBillingInfo(
                                               │    billing_account_name=""
                                               │  )
                                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  TARGET PROJECT  (the one that gets killed)                              │
│                                                                          │
│   Billing disassociated → all resources gradually stop:                  │
│     - Cloud Run revisions stop serving                                   │
│     - Vertex AI calls return 403                                         │
│     - BigQuery queries fail                                              │
│     - Cloud Functions stop firing                                        │
│     - Firestore reads start failing                                      │
│   (data preserved — for 30 days before GCP starts deletion clock)        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why two projects?

If the Cloud Function lived in the target project, disabling billing on the target would kill the function mid-execution. The two-project layout is essential. The module has a precondition guard (`terraform_data.guard_two_project`) that fails `terraform plan` if `target_project_id == killswitch_project_id`.

## Prerequisites

### 1. Two GCP projects

* **Target project** — the one you want to cap. For Liveli, this is `liveli-496609` (the default in `variables.tf`).
* **Killswitch project** — a separate project that hosts the kill-switch function. Create it:

  ```bash
  gcloud projects create liveli-killswitch \
    --name="Liveli billing kill-switch" \
    --no-enable-cloud-apis

  # Link to the same billing account
  gcloud billing projects link liveli-killswitch \
    --billing-account=<BILLING_ACCOUNT_ID>
  ```

  The killswitch project itself costs essentially nothing — one Cloud Function that fires a handful of times per day, plus a Pub/Sub topic and some monitoring. Expect £0–£1/month.

### 2. Google Cloud mobile app and notification channel

The mobile push alert routes through an *existing* Cloud Monitoring notification channel of type `google_cloud_monitoring_mobile`. Create it once via the mobile app:

1. Install **Google Cloud** from the App Store / Google Play
2. Sign in with the Google Workspace account that has access to the killswitch project
3. Open the app — it registers the device as a notification channel automatically
4. Find the channel's display name:

   ```bash
   gcloud alpha monitoring channels list \
     --filter='type=google_cloud_monitoring_mobile' \
     --project=<KILLSWITCH_PROJECT_ID>
   ```

   The `displayName` field is what you set as `mobile_channel_display_name` in `terraform.tfvars`. It's usually something like `"Jay's iPhone — Google Cloud app"`.

### 3. Required tools

* Terraform `>= 1.6.0`
* `gcloud` CLI authenticated to a principal with:
  * `roles/owner` (or equivalent) on the killswitch project
  * `roles/billing.admin` on the billing account
  * Access to read IAM on the target project

## Apply

```bash
# From this directory
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars to fill in billing_account_id, killswitch_project_id,
# and mobile_channel_display_name.

terraform init
terraform plan          # verify the resource count and the precondition guard
terraform apply
```

The precondition guard fires at plan time if you accidentally set `target_project_id == killswitch_project_id`. If you see that error, stop and fix the config — applying with both equal would create a footgun.

After apply, save the outputs for the test procedure:

```bash
terraform output -raw pubsub_topic_id > /tmp/billing-topic
terraform output -raw function_name > /tmp/billing-fn
terraform output -raw function_logs_url
```

## Test procedure

Two paths — one safe, one all-the-way.

### Safe test — DRY_RUN mode (recommended)

Set `dry_run = true` in `terraform.tfvars`, re-apply, then publish a synthetic over-budget message:

```bash
# Construct a budget notification payload that claims cost > budget
PAYLOAD='{
  "budgetDisplayName": "test",
  "costAmount": 999,
  "budgetAmount": 500,
  "currencyCode": "GBP",
  "alertThresholdExceeded": 1.0
}'

# Base64-encode and publish to the topic
gcloud pubsub topics publish "$(terraform output -raw pubsub_topic_id)" \
  --message="$PAYLOAD" \
  --project=<KILLSWITCH_PROJECT_ID>
```

Watch the function logs (the `function_logs_url` output) — you should see:

* `INFO Budget notification received` with cost=999, budget=500, ratio=1.998
* `WARNING threshold_crossed` (this triggers the mobile alert pipeline)
* `WARNING DRY_RUN mode — would have disabled billing but skipping.`

If the mobile + email channels are wired correctly, you should also receive a push notification on your phone and an email at `support@liveli.ai` and `jay@liveli.ai` within ~2 minutes.

**Critically — billing on the target project is NOT actually touched in DRY_RUN mode.** You can run this test repeatedly without consequences.

### Full test — actually disable billing on a throwaway project

If you want end-to-end confidence the `updateBillingInfo` call works, do this against a throwaway project, NOT against `liveli-496609`:

1. Create a throwaway project and link it to the billing account
2. Override `target_project_id = "throwaway-test-project"` in `terraform.tfvars`
3. Set `dry_run = false`
4. `terraform apply`
5. Publish the same synthetic message above
6. Verify the throwaway project's billing is now disassociated:

   ```bash
   gcloud billing projects describe throwaway-test-project
   # Expect: billingEnabled: false
   ```

7. Re-link billing to the throwaway project manually in the console, OR `terraform destroy`

After verifying, switch `target_project_id` back to `liveli-496609`, set `dry_run = false`, and `terraform apply`.

## Rollback

### Just remove the kill-switch (keep current billing state)

```bash
terraform destroy
```

This removes the budget, function, topic, alerts, and all IAM. **Does not touch the target project's billing state** — if billing was already disabled when you destroy, it stays disabled.

### If the kill-switch fired in production and you need service back

1. **Identify and fix the spend driver** before re-enabling billing — otherwise you'll just hit the cap again. Check the function logs for the cost breakdown around the time of the fire.
2. **Re-link billing in the GCP console**:
   * Open https://console.cloud.google.com/billing/projects?project=<TARGET_PROJECT_ID>
   * Find the target project in the list (it'll show "Billing is disabled")
   * Click the three-dot menu → "Change billing"
   * Select the original billing account
3. **Wait ~5 minutes** for Cloud Run / Cloud Functions / etc. to come back online. Some services may need an explicit redeploy if they were stopped mid-flight.
4. **Verify spend hasn't kept climbing** — review the new charges in the GCP billing console and confirm the issue is contained.

## What this module does NOT prevent

Be honest about the caveats. The kill-switch is a soft cap with a known overshoot window:

* **Billing data lag.** GCP's billing telemetry lags actual spend by 4–24 hours. By the time the function fires at "cost ≥ £500", real-world spend might already be £520–£600. The cap is NOT a hard wall — expect overshoot of £20–£80 on full-tilt spend.
* **Committed Use Discounts (CUDs).** If you ever buy a 1-year or 3-year commitment, you'll be billed for that commitment even after billing is disabled. Liveli has none of these today.
* **Reservations.** Same as CUDs — BigQuery slot reservations, Compute Engine reservations, etc. continue billing. Liveli has none.
* **Marketplace subscriptions.** Third-party subscriptions bought via GCP Marketplace continue. Liveli has none.
* **In-flight workloads.** Already-started BigQuery queries finish (and bill for it). Network egress in flight completes. Tail charges of ~£1–£10 expected.

## Mobile alerting — design choice

The spec asked to pick whichever route gives reliable per-threshold push notifications. We use a **log-based metric on the Cloud Function's logs**, not a metric on the Pub/Sub topic message count. The trade-offs:

| Approach | Pros | Cons |
|---|---|---|
| Log-based metric on function logs ✅ | Per-threshold semantics via metric label, structured by the function itself, only counts genuine threshold crossings | ~1 minute Cloud Logging ingestion delay |
| Metric on Pub/Sub topic message count ❌ | Lowest latency | Counts every message including sub-threshold spend updates — alert spam. Can't filter per-threshold without parsing the message body, which you can't do from Cloud Monitoring |

The ~1 minute ingestion delay is irrelevant in context: billing data already lags by hours, so the metric pipeline isn't the bottleneck.

## The "kill-switch's own kill-switch"

A separate alerting policy (`function_health`) fires if the Cloud Function itself errors out. This catches the failure modes where the kill-switch SHOULD have stopped spend but didn't:

* IAM mis-config (function SA missing roles, `updateBillingInfo` returns 403)
* Function-side bug
* Malformed budget message
* Cloud Billing API degradation

Without this, you'd only notice the kill-switch failed when the bill arrives. With it, you get a mobile + email alert specifically tagged as "kill-switch malfunction" before the bill arrives, so you can manually intervene.

## File layout

```
infra/billing-cap/
├── versions.tf                         # Provider versions, GCS backend, aliases
├── main.tf                             # All resources (~350 lines, commented)
├── variables.tf                        # Input variables with validation
├── outputs.tf                          # Useful outputs for ops/testing
├── terraform.tfvars.example            # Copy-and-fill template
├── functions/
│   └── disable_billing/
│       ├── main.py                     # CloudEvent handler — disables billing
│       └── requirements.txt            # functions-framework + google-cloud-billing
└── README.md                           # This file
```

## Operating notes

* **State file** lives at `gs://liveli-tf-state-eu/infra/billing-cap/state` — separate from the main infra state so this module can be applied/destroyed independently.
* **Default labels** applied to every resource: `product=liveli`, `managed_by=terraform`, `repo=jay-nexusascent-liveli`, `module=billing-cap`. Use these to filter the GCP billing console.
* **Region** is `europe-west4` to match Liveli's Cloud Run / Artifact Registry / Secret Manager convention.
* **Function memory** is 256Mi — the handler is tiny, more isn't useful.
* **Function timeout** is 60s — `updateBillingInfo` typically completes in <1s. The 60s is for headroom in case of Cloud Billing API slowness.
* **Pub/Sub retry policy** is `RETRY_POLICY_RETRY` — combined with the idempotency check in the function, this guarantees the kill-switch fires even through transient failures.

## Reference

* GCP's reference architecture: https://cloud.google.com/billing/docs/how-to/notify
* Programmatic disable: https://cloud.google.com/billing/docs/how-to/notify#cap_disable_billing_to_stop_usage
* Cloud Functions gen 2 + Pub/Sub triggers: https://cloud.google.com/functions/docs/calling/pubsub
