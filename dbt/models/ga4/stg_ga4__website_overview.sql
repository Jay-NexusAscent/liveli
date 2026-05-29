{{
  config(
    materialized = 'view',
    description = 'Cleaned view over raw tap-ga4 website_overview — date parsed from YYYYMMDD, metrics passed through (already typed). One row per day.'
  )
}}

-- Column names + types verified against the real synced BQ schema:
-- date is STRING in YYYYMMDD form; metrics are already INT64/FLOAT64.

with raw as (
    select * from {{ source('ga4', 'website_overview') }}
)

select
    safe.parse_date('%Y%m%d', date)                                   as event_date,

    activeUsers                                                       as active_users,
    newUsers                                                          as new_users,
    sessions,
    sessionsPerUser                                                  as sessions_per_user,
    averageSessionDuration                                           as avg_session_duration_seconds,
    screenPageViews                                                  as pageviews,
    screenPageViewsPerSession                                        as pageviews_per_session,
    bounceRate                                                       as bounce_rate,
    engagementRate                                                   as engagement_rate

from raw
where safe.parse_date('%Y%m%d', date) is not null
