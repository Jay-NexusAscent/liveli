{{
  config(
    materialized = 'table',
    description = 'Daily event counts per event name + user. Aggregated from raw events; useful for funnel + retention queries.',
    cluster_by = ['event_date']
  )
}}

select
    date(event_time)                                                  as event_date,
    event_name,

    count(*)                                                          as event_count,
    count(distinct user_id)                                           as unique_users,

    -- Geo + device breakouts at the day grain — saves the agent from
    -- aggregating the full event stream for "events by country" queries.
    count(distinct country)                                           as distinct_countries,
    count(distinct os)                                                as distinct_os

from {{ ref('stg_mixpanel__events') }}
where event_time is not null
group by event_date, event_name
