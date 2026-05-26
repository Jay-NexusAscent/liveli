{{
  config(
    materialized = 'table',
    description = 'One row per Shopify order — the canonical analytical grain for revenue and AOV questions.',
    cluster_by = ['created_at']
  )
}}

select
    order_id,
    order_number,
    order_name,
    customer_id,
    customer_email,

    -- Net revenue = subtotal - discounts (excludes tax + shipping for
    -- "true product revenue" metrics). Total stays available alongside.
    total_price,
    subtotal_price,
    total_tax,
    total_discounts,
    total_shipping,
    subtotal_price - coalesce(total_discounts, 0)                     as revenue_net,
    currency,

    financial_status,
    fulfillment_status,
    is_paid,
    is_fulfilled,
    is_cancelled,
    is_test_order,

    created_at,
    date(created_at)                                                  as order_date

from {{ ref('stg_shopify__orders') }}
where not coalesce(is_test_order, false)                              -- exclude Shopify test orders from facts
