{{
  config(
    materialized = 'view',
    description = 'Lightly-cleaned view over raw tap-stripe charges — currency-normalised amounts, derived status flags, timestamp cast.'
  )
}}

with raw as (
    select * from {{ source('stripe', 'charges') }}
)

select
    id                                                                as charge_id,
    customer                                                          as customer_id,

    -- Stripe amounts are in the smallest currency unit (cents for USD,
    -- pence for GBP). Divide to get major-unit amount for human-readable
    -- reporting; keep the raw int as `amount_minor` for exact arithmetic.
    amount                                                            as amount_minor,
    safe_divide(amount, 100.0)                                        as amount,
    coalesce(amount_refunded, 0)                                      as amount_refunded_minor,
    safe_divide(coalesce(amount_refunded, 0), 100.0)                  as amount_refunded,
    safe_divide(amount - coalesce(amount_refunded, 0), 100.0)         as amount_net,
    upper(currency)                                                   as currency,

    status,
    paid,
    captured,
    refunded,

    -- Derived flags — convenience for fct_charges + agent queries.
    status = 'succeeded' and not coalesce(refunded, false)            as is_successful,
    coalesce(amount_refunded, 0) > 0                                  as has_refund,
    coalesce(amount_refunded, 0) >= amount                            as is_fully_refunded,

    description,
    failure_code,
    failure_message,

    -- Stripe timestamps come through as INT64 epoch seconds OR
    -- TIMESTAMP depending on tap version. SAFE_CAST + TIMESTAMP_SECONDS
    -- handles both: if it's already a TIMESTAMP the cast is a no-op,
    -- if INT64 the seconds-converter kicks in. Brittle? Slightly. But
    -- the alternative is a separate model per tap-version.
    coalesce(
      safe_cast(created as timestamp),
      timestamp_seconds(safe_cast(created as int64))
    )                                                                 as created_at

from raw
