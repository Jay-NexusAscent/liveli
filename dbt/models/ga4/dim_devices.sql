{{
  config(
    materialized = 'table',
    description = 'Daily metrics broken down by device dimensions (category / OS / browser). One row per (date, device combination). Use for "what devices do my visitors use" questions.',
    cluster_by = ['event_date']
  )
}}

with raw as (
    select * from {{ source('ga4', 'devices') }}
)

select
    safe.parse_date('%Y%m%d', date)                                   as event_date,

    deviceCategory                                                  as device_category,    -- desktop / mobile / tablet
    deviceModel                                                     as device_model,
    operatingSystem                                                 as operating_system,
    browser,

    activeUsers                                                     as active_users,
    newUsers                                                        as new_users,
    sessions,
    averageSessionDuration                                          as avg_session_duration_seconds,
    screenPageViews                                                 as pageviews,
    bounceRate                                                      as bounce_rate,
    engagementRate                                                  as engagement_rate

from raw
where safe.parse_date('%Y%m%d', date) is not null
