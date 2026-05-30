{{
  config(
    materialized = 'table',
    description = 'Mixpanel users (engage profiles) with derived activity aggregates from events.'
  )
}}

with profiles as (
    select
        distinct_id                                                   as user_id,
        safe_cast(`$properties` as string)                            as profile_properties_json,
        safe_cast(`$created` as timestamp)                            as profile_created_at

    from {{ source('mixpanel', 'engage') }}
),

activity as (
    select
        user_id,
        count(*)                                                      as lifetime_event_count,
        count(distinct event_name)                                    as distinct_events_triggered,
        min(event_time)                                               as first_event_at,
        max(event_time)                                               as last_event_at

    from {{ ref('stg_mixpanel__events') }}
    where user_id is not null
    group by user_id
)

select
    p.user_id,
    p.profile_properties_json,
    p.profile_created_at,

    coalesce(a.lifetime_event_count, 0)                               as lifetime_event_count,
    coalesce(a.distinct_events_triggered, 0)                          as distinct_events_triggered,
    a.first_event_at,
    a.last_event_at,

    -- Engagement flag — fired >10 events in their lifetime. Arbitrary
    -- threshold; refine after product-team feedback.
    coalesce(a.lifetime_event_count, 0) >= 10                         as is_engaged

from profiles p
left join activity a using (user_id)
