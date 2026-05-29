{{
  config(
    materialized = 'table',
    description = 'Daily metrics broken down by geography (country / region / city). One row per (date, location combination). Use for "where are my visitors from" questions.',
    cluster_by = ['event_date']
  )
}}

with raw as (
    select * from {{ source('ga4', 'locations') }}
)

select
    safe.parse_date('%Y%m%d', date)                                   as event_date,

    country,
    countryId                                                       as country_id,
    region,
    city,
    cityId                                                          as city_id,

    activeUsers                                                     as active_users,
    newUsers                                                        as new_users,
    sessions,
    averageSessionDuration                                          as avg_session_duration_seconds,
    screenPageViews                                                 as pageviews,
    bounceRate                                                      as bounce_rate,
    engagementRate                                                  as engagement_rate

from raw
where safe.parse_date('%Y%m%d', date) is not null
