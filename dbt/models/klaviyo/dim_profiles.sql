{{
  config(
    materialized = 'table',
    description = 'Klaviyo profiles with lifetime engagement aggregates from events.'
  )
}}

with profiles as (
    select
        id                                                            as profile_id,
        safe_cast(json_value(attributes, '$.email') as string)        as email,
        safe_cast(json_value(attributes, '$.first_name') as string)   as first_name,
        safe_cast(json_value(attributes, '$.last_name') as string)    as last_name,
        safe_cast(json_value(attributes, '$.created') as timestamp)   as created_at
    from {{ source('klaviyo', 'profiles') }}
),

activity as (
    select
        profile_id,
        count(*)                                                      as lifetime_event_count,
        countif(event_name = 'Opened Email')                          as opens,
        countif(event_name = 'Clicked Email')                         as clicks,
        countif(event_name = 'Placed Order')                          as orders,
        sum(if(event_name = 'Placed Order', event_value, 0))          as lifetime_revenue,
        max(event_time)                                               as last_event_at

    from {{ ref('stg_klaviyo__events') }}
    where profile_id is not null
    group by profile_id
)

select
    p.profile_id,
    p.email,
    p.first_name,
    p.last_name,
    p.created_at,

    coalesce(a.lifetime_event_count, 0)                               as lifetime_event_count,
    coalesce(a.opens, 0)                                              as opens,
    coalesce(a.clicks, 0)                                             as clicks,
    coalesce(a.orders, 0)                                             as orders,
    coalesce(a.lifetime_revenue, 0)                                   as lifetime_revenue,
    a.last_event_at,

    coalesce(a.orders, 0) > 0                                         as is_customer

from profiles p
left join activity a using (profile_id)
