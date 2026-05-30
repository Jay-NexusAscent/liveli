"""
Disable billing on a target GCP project when monthly spend crosses the cap.

This Cloud Function (gen 2, Python 3.12) is triggered by Pub/Sub messages
from a Cloud Billing budget's all_updates_rule. Adapted from Google's
reference at https://cloud.google.com/billing/docs/how-to/notify.

Behaviour:
    * Logs every invocation at INFO with cost/budget/ratio detail.
    * Emits a structured "threshold_crossed" log entry at WARNING whenever
      the budget message reports an alertThresholdExceeded value — picked
      up by a log-based metric and routed to a mobile + email alert.
    * If costAmount >= budgetAmount, calls
      projects.updateBillingInfo() with billing_account_name="" to
      disassociate the target project from its billing account. This
      stops essentially all charges within minutes.
    * Idempotent: short-circuits if cost < budget (Pub/Sub fires for every
      spend update, not just threshold crossings) and again if billing is
      already disabled (at-least-once delivery means messages get redelivered).
    * Supports DRY_RUN mode via env var — logs what it would have done
      without actually calling updateBillingInfo. Use for end-to-end testing.

Required env vars:
    TARGET_PROJECT_ID  — project ID whose billing gets disabled
    DRY_RUN            — "true" to log without acting (default "false")

Required IAM (granted by the Terraform that deploys this function):
    On TARGET_PROJECT_ID:   roles/billing.projectManager
    On the billing account: roles/billing.user
"""

import base64
import json
import logging
import os
from typing import Any

import functions_framework
import google.cloud.logging
from google.cloud import billing_v1
from google.cloud.billing_v1.types import ProjectBillingInfo

# Structured logging via google-cloud-logging. Installs a handler that
# turns Python logging records (including extra={"json_fields": {...}})
# into Cloud Logging entries with proper jsonPayload fields. Without
# this, basicConfig writes plain text to stdout and the json_fields are
# silently dropped — the log-based metric filter on jsonPayload.*
# never matches and no alert ever fires.
google.cloud.logging.Client().setup_logging(log_level=logging.INFO)

# Environment variables are populated by Terraform's service_config.
# Validate at module load so a misdeployment fails fast on first invocation
# rather than silently no-op'ing.
TARGET_PROJECT_ID = os.environ["TARGET_PROJECT_ID"]
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"

# Module-level client — Cloud Functions gen 2 reuses function instances
# across concurrent invocations, so client initialization happens once
# per warm instance rather than once per request.
_billing_client = billing_v1.CloudBillingClient()


@functions_framework.cloud_event
def stop_billing(cloud_event: Any) -> None:
    """
    Cloud Function entry point. Receives a CloudEvent wrapping a Pub/Sub
    message published by a Cloud Billing budget notification.
    """
    try:
        budget_notification = _parse_budget_message(cloud_event)
    except (KeyError, ValueError, json.JSONDecodeError) as exc:
        # Log at ERROR so the function-health alert fires. The Pub/Sub
        # retry policy will redeliver, but if the message is permanently
        # malformed every retry will fail the same way until it dead-letters.
        logging.error(
            "Failed to parse budget notification — refusing to act.",
            extra={"json_fields": {"error": str(exc), "error_type": type(exc).__name__}},
            exc_info=True,
        )
        # Re-raise so Pub/Sub treats this as a failed delivery and retries.
        # Genuine malformed messages will keep failing until they dead-letter,
        # which is the desired behaviour — don't silently swallow.
        raise

    cost_amount = float(budget_notification.get("costAmount", 0))
    budget_amount = float(budget_notification.get("budgetAmount", 0))
    threshold_exceeded = budget_notification.get("alertThresholdExceeded")
    currency_code = budget_notification.get("currencyCode", "?")

    # Guard against malformed/zero-budget messages causing div-by-zero.
    ratio = cost_amount / budget_amount if budget_amount > 0 else 0.0

    # Log every invocation at INFO. This is the observability backbone —
    # if you want to know whether the function is being called and what
    # it's seeing, this log entry is the source of truth.
    logging.info(
        "Budget notification received",
        extra={
            "json_fields": {
                "cost_amount": cost_amount,
                "budget_amount": budget_amount,
                "ratio": round(ratio, 4),
                "threshold_exceeded": threshold_exceeded,
                "currency_code": currency_code,
                "target_project": TARGET_PROJECT_ID,
                "dry_run": DRY_RUN,
            }
        },
    )

    # Emit a structured "threshold_crossed" entry for any message that
    # represents a threshold crossing. The log-based metric named
    # billing_cap_threshold_crossed in main.tf filters on this and feeds
    # the mobile + email alerting policy. Stringify the threshold so the
    # metric label is consistent regardless of numeric representation.
    if threshold_exceeded is not None:
        logging.warning(
            "threshold_crossed",
            extra={
                "json_fields": {
                    "threshold_crossed": "true",
                    "threshold": str(threshold_exceeded),
                    "cost_amount": cost_amount,
                    "budget_amount": budget_amount,
                    "ratio": round(ratio, 4),
                    "target_project": TARGET_PROJECT_ID,
                }
            },
        )

    # Short-circuit: only proceed to kill-switch logic if at or over budget.
    # Pub/Sub fires multiple times per day for sub-threshold spend updates;
    # those don't need any action beyond the INFO log above.
    if cost_amount < budget_amount:
        return

    # At-least-once delivery — the same threshold-crossing message can be
    # redelivered even after we've already disabled billing. Read current
    # state before acting; if billing is already disabled, log and return.
    project_name = f"projects/{TARGET_PROJECT_ID}"
    project_billing_info = _billing_client.get_project_billing_info(name=project_name)

    if not project_billing_info.billing_account_name:
        logging.info(
            "Billing already disabled — idempotent no-op.",
            extra={"json_fields": {"target_project": TARGET_PROJECT_ID}},
        )
        return

    previous_billing_account = project_billing_info.billing_account_name

    if DRY_RUN:
        logging.warning(
            "DRY_RUN mode — would have disabled billing but skipping.",
            extra={
                "json_fields": {
                    "dry_run": True,
                    "target_project": TARGET_PROJECT_ID,
                    "would_have_disabled_billing_account": previous_billing_account,
                    "cost_amount": cost_amount,
                    "budget_amount": budget_amount,
                }
            },
        )
        return

    # Actually disable billing. Clear billing_account_name and update.
    # This is the kill-switch firing.
    updated_info = ProjectBillingInfo(billing_account_name="")
    _billing_client.update_project_billing_info(
        name=project_name,
        project_billing_info=updated_info,
    )

    logging.critical(
        "KILL-SWITCH FIRED — billing disabled on target project.",
        extra={
            "json_fields": {
                "kill_switch_fired": True,
                "target_project": TARGET_PROJECT_ID,
                "previous_billing_account": previous_billing_account,
                "cost_amount": cost_amount,
                "budget_amount": budget_amount,
                "currency_code": currency_code,
            }
        },
    )


def _parse_budget_message(cloud_event: Any) -> dict:
    """
    Extract and decode the JSON budget notification from a CloudEvent.

    Cloud Functions gen 2 receives Pub/Sub messages wrapped in a CloudEvent.
    The actual message body is at cloud_event.data["message"]["data"],
    base64-encoded.

    Raises:
        KeyError: if the expected CloudEvent shape is missing.
        ValueError: if the base64 decoding fails.
        json.JSONDecodeError: if the decoded payload is not valid JSON.
    """
    pubsub_message = cloud_event.data["message"]
    encoded_data = pubsub_message.get("data", "")

    if not encoded_data:
        raise ValueError("Pub/Sub message has empty data field")

    decoded_bytes = base64.b64decode(encoded_data)
    decoded_str = decoded_bytes.decode("utf-8")
    return json.loads(decoded_str)
