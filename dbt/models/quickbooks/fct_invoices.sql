{{
  config(
    materialized = 'table',
    description = 'One row per QuickBooks invoice with derived AR aging buckets. Headline fact for accounts-receivable analytics.',
    cluster_by = ['invoice_date']
  )
}}

select
    invoice_id,
    invoice_number,
    customer_id,
    customer_name,

    total_amount,
    balance_remaining,
    amount_paid,
    currency,

    is_paid,
    is_partially_paid,
    not is_paid                                                       as is_outstanding,

    invoice_date,
    due_date,
    days_past_due,

    -- Standard AR aging buckets — used in every accounting report.
    case
        when is_paid then 'paid'
        when days_past_due is null or days_past_due <= 0 then 'current'
        when days_past_due <= 30 then '1-30 days'
        when days_past_due <= 60 then '31-60 days'
        when days_past_due <= 90 then '61-90 days'
        else '90+ days'
    end                                                               as aging_bucket,

    email_status,
    created_at,
    updated_at

from {{ ref('stg_quickbooks__invoice') }}
