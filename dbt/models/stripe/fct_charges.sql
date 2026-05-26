{{
  config(
    materialized = 'table',
    description = 'One row per Stripe charge — the canonical analytical grain for revenue questions. Joined to dim_customers via customer_id.',
    cluster_by = ['created_at']
  )
}}

-- Why a table (not view): charges is queried frequently (revenue dashboards,
-- "show me yesterday's charges" prompts). Clustering by created_at means
-- date-filtered queries scan only relevant blocks.

select
    charge_id,
    customer_id,
    currency,
    amount,
    amount_minor,
    amount_refunded,
    amount_net,
    status,
    is_successful,
    has_refund,
    is_fully_refunded,
    failure_code,
    failure_message,
    description,
    created_at,
    date(created_at)                                                  as charge_date

from {{ ref('stg_stripe__charges') }}
