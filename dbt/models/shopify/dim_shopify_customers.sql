{{
  config(
    materialized = 'table',
    description = 'Shopify customers with lifetime aggregates from orders. Combines Shopify pre-computed totals (orders_count, total_spent) with our own derivations from fct_orders for cross-checking.'
  )
}}

with customers as (
    select
        id                                                            as customer_id,
        email,
        first_name,
        last_name,
        phone,
        accepts_marketing,
        verified_email,

        safe_cast(orders_count as int64)                              as shopify_orders_count,    -- Shopify's pre-aggregate
        safe_cast(total_spent as numeric)                             as shopify_total_spent,

        safe_cast(created_at as timestamp)                            as created_at,
        safe_cast(updated_at as timestamp)                            as updated_at

    from {{ source('shopify', 'customers') }}
),

order_aggs as (
    select
        customer_id,
        count(*)                                                      as lifetime_order_count,
        countif(is_paid)                                              as lifetime_paid_order_count,
        sum(if(is_paid, revenue_net, 0))                              as lifetime_revenue_net,
        min(order_date)                                               as first_order_date,
        max(order_date)                                               as last_order_date

    from {{ ref('fct_orders') }}
    where customer_id is not null
    group by customer_id
)

select
    c.customer_id,
    c.email,
    c.first_name,
    c.last_name,
    c.phone,
    c.accepts_marketing,
    c.verified_email,
    c.created_at,

    -- Both Shopify's pre-aggregate AND our own derived totals — useful
    -- for sanity-checking when the two diverge (deleted orders, etc.).
    c.shopify_orders_count,
    c.shopify_total_spent,
    coalesce(o.lifetime_order_count, 0)                               as lifetime_order_count,
    coalesce(o.lifetime_paid_order_count, 0)                          as lifetime_paid_order_count,
    coalesce(o.lifetime_revenue_net, 0)                               as lifetime_revenue_net,
    o.first_order_date,
    o.last_order_date,

    coalesce(o.lifetime_paid_order_count, 0) > 1                      as is_repeat_buyer

from customers c
left join order_aggs o using (customer_id)
