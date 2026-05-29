{{
  config(
    materialized = 'table',
    description = 'Daily site-wide GA4 metrics — one row per day with users, sessions, pageviews, engagement. The headline fact for "how is my site doing" questions. Populated from website_overview (no source/medium dimensions, so not subject to GA4 low-traffic thresholding the way traffic_sources is).',
    cluster_by = ['event_date']
  )
}}

select
    event_date,
    active_users,
    new_users,
    sessions,
    sessions_per_user,
    avg_session_duration_seconds,
    pageviews,
    pageviews_per_session,
    bounce_rate,
    engagement_rate,

    -- Returning-user count derived from the two GA4 gives us. Useful
    -- for retention-flavoured questions without a separate report.
    greatest(active_users - new_users, 0)                            as returning_users

from {{ ref('stg_ga4__website_overview') }}
