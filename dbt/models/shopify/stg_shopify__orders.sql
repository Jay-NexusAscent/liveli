{{
  config(
    materialized = 'view',
    description = 'Cleaned view over raw tap-shopify orders — money fields cast to numeric, status derived flags, currency normalised.'
  )
}}

with raw as (
    select * from {{ source('shopify', 'orders') }}
)

select
    id                                                                as order_id,
    order_number,
    name                                                              as order_name,           -- e.g. "#1001"

    -- Customer reference. tap-shopify nests customer fields; the
    -- top-level table usually has customer.id flattened. Add a
    -- defensive coalesce in case it lands as customer_id directly.
    coalesce(safe_cast(customer_id as string),
             safe_cast(json_value(customer, '$.id') as string))       as customer_id,
    email                                                             as customer_email,

    -- Money fields. Shopify API returns these as strings ("29.99").
    -- SAFE_CAST handles strings + already-numeric defensively.
    safe_cast(total_price as numeric)                                 as total_price,
    safe_cast(subtotal_price as numeric)                              as subtotal_price,
    safe_cast(total_tax as numeric)                                   as total_tax,
    safe_cast(total_discounts as numeric)                             as total_discounts,
    safe_cast(total_shipping_price_set as numeric)                    as total_shipping,
    upper(currency)                                                   as currency,

    financial_status,                  -- pending / paid / partially_paid / refunded / voided
    fulfillment_status,                -- null / partial / fulfilled / restocked
    cancelled_at,
    cancel_reason,
    test                               as is_test_order,

    -- Convenience flags
    financial_status = 'paid'                                         as is_paid,
    fulfillment_status = 'fulfilled'                                  as is_fulfilled,
    cancelled_at is not null                                          as is_cancelled,

    safe_cast(created_at as timestamp)                                as created_at,
    safe_cast(updated_at as timestamp)                                as updated_at

from raw
