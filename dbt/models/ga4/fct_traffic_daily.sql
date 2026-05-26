{{
  config(
    materialized = 'table',
    description = 'Daily traffic fact — one row per (date, source, medium) with engagement metrics. The customer-facing analytical grain for "show me my traffic" questions.',
    cluster_by = ['event_date']
  )
}}

-- Materialised as a table (not view) because the agent + dashboards
-- query this frequently; one BQ table scan beats re-aggregating the
-- staging view on every query. Clustered by event_date because nearly
-- every query filters by a date range.

with cleaned as (
    select * from {{ ref('stg_ga4__traffic_sources') }}
)

select
    event_date,
    source,
    medium,
    source_platform,

    -- Group at (date, source, medium) — the natural grain for daily
    -- attribution analysis. Aggregations handle the edge case where
    -- tap-ga4 might emit duplicate rows on re-sync (idempotency belt).
    sum(active_users)                                                 as active_users,
    sum(sessions)                                                     as sessions,
    avg(sessions_per_user)                                            as avg_sessions_per_user,
    avg(bounce_rate)                                                  as avg_bounce_rate,
    avg(engagement_rate)                                              as avg_engagement_rate

from cleaned
group by event_date, source, medium, source_platform
