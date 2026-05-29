{{
  config(
    materialized = 'table',
    description = 'Stripe customers with lifetime aggregates from charges. Small (typically <100K rows even for high-customer-count businesses); rebuilt every sync.'
  )
}}

-- TODO: verify tap-stripe customer columns after first sync. Stripe API
-- has: id, email, name, description, created, currency, balance,
-- delinquent, livemode, metadata. The tap may emit a subset / different
-- naming.

with customers as (
    select
        id                                                            as customer_id,
        email,
        name,
        description,
        coalesce(
          safe_cast(created as timestamp),
          timestamp_seconds(safe_cast(created as int64))
        )                                                             as created_at,
        delinquent,
        livemode

    from {{ source('stripe', 'customers') }}
),

charge_aggs as (
    select
        customer_id,
        count(*)                                                      as lifetime_charge_count,
        countif(is_successful)                                        as lifetime_successful_charge_count,
        sum(if(is_successful, amount_net, 0))                         as lifetime_revenue_net,
        sum(if(is_successful, amount, 0))                             as lifetime_revenue_gross,
        min(if(is_successful, charge_date, null))                     as first_charge_date,
        max(if(is_successful, charge_date, null))                     as last_charge_date

    from {{ ref('fct_charges') }}
    where customer_id is not null
    group by customer_id
)

select
    c.customer_id,
    c.email,
    c.name,
    c.description,
    c.created_at,
    c.delinquent,
    c.livemode,

    coalesce(a.lifetime_charge_count, 0)                              as lifetime_charge_count,
    coalesce(a.lifetime_successful_charge_count, 0)                   as lifetime_successful_charge_count,
    coalesce(a.lifetime_revenue_net, 0)                               as lifetime_revenue_net,
    coalesce(a.lifetime_revenue_gross, 0)                             as lifetime_revenue_gross,
    a.first_charge_date,
    a.last_charge_date,

    -- Convenience flags for cohort / segmentation queries.
    coalesce(a.lifetime_successful_charge_count, 0) > 1               as is_repeat_buyer,
    coalesce(a.lifetime_revenue_net, 0) >= 1000                       as is_high_value         -- threshold arbitrary; refine post-launch

from customers c
left join charge_aggs a using (customer_id)
