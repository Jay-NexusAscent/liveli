{{
  config(
    materialized = 'view',
    description = 'Lightly-cleaned view over raw tap-ga4 traffic_sources table — cast date to DATE, lowercase strings, defensive null handling. Cheap (view, no storage); fct_/dim_ models build on this.'
  )
}}

-- Why a view (not a table): staging models are cheap pass-throughs;
-- materialising would duplicate raw storage for a one-to-one mapping.
-- Facts and dimensions downstream do materialise as tables.

with raw as (
    select * from {{ source('ga4', 'traffic_sources') }}
)

select
    -- Cast `date` from STRING (tap emits ISO yyyy-mm-dd as text) to DATE
    -- so downstream models can do proper date arithmetic without
    -- repeated parse_date() calls.
    safe.parse_date('%Y-%m-%d', date)                                 as event_date,

    -- Lowercase + null-coerce string dimensions. GA4 returns
    -- "(direct)" / "(none)" for unattributed traffic — preserve those
    -- as-is, they're conventional and customer-readable.
    lower(coalesce(source, '(unknown)'))                              as source,
    lower(coalesce(medium, '(unknown)'))                              as medium,
    lower(coalesce(sourcePlatform, '(unknown)'))                      as source_platform,

    -- Numeric metrics — passthrough. GA4 returns these as STRINGs
    -- through the Data API; cast to numeric for arithmetic.
    safe_cast(activeUsers as int64)                                   as active_users,
    safe_cast(sessions as int64)                                      as sessions,
    safe_cast(sessionsPerUser as float64)                             as sessions_per_user,
    safe_cast(bounceRate as float64)                                  as bounce_rate,
    safe_cast(engagementRate as float64)                              as engagement_rate

from raw

-- Drop rows with unparseable dates — they'd corrupt all downstream
-- time-series math. SAFE.PARSE_DATE returns NULL on failure.
where safe.parse_date('%Y-%m-%d', date) is not null
