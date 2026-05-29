{{
  config(
    materialized = 'table',
    description = 'Per-page daily metrics — one row per (date, page path). Pageviews, engagement, bounce. The grain for "which pages get the most traffic" questions.',
    cluster_by = ['event_date']
  )
}}

-- Reads the pages source directly — it's already at the (date, page)
-- grain we want, no intermediate staging view needed.

with raw as (
    select * from {{ source('ga4', 'pages') }}
)

select
    safe.parse_date('%Y%m%d', date)                                   as event_date,

    hostName                                                         as host_name,
    pagePath                                                         as page_path,
    -- Session-level acquisition dims GA4 attaches to the pages report.
    lower(coalesce(sessionSource, '(unknown)'))                       as session_source,
    lower(coalesce(sessionMedium, '(unknown)'))                       as session_medium,

    activeUsers                                                      as active_users,
    screenPageViews                                                 as pageviews,
    engagedSessions                                                 as engaged_sessions,
    eventCount                                                      as event_count,
    screenPageViewsPerUser                                          as pageviews_per_user,
    userEngagementDuration                                          as user_engagement_duration_seconds,
    bounceRate                                                      as bounce_rate,
    engagementRate                                                  as engagement_rate

from raw
where safe.parse_date('%Y%m%d', date) is not null
