{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-mixpanel events — flatten common event properties, cast time.'
  )
}}

with raw as (
    select * from {{ source('mixpanel', 'events') }}
)

select
    -- Event name lives at the top level as `event`. Quoted because
    -- `event` is a reserved-ish word in some SQL dialects.
    `event`                                                           as event_name,

    -- Mixpanel uses `distinct_id` for the user identifier.
    distinct_id                                                       as user_id,

    -- Time comes as INT64 epoch (seconds or millis depending on tap
    -- config). Handle both — if it's > 1e12 it's milliseconds.
    case
        when safe_cast(time as int64) > 1000000000000
        then timestamp_millis(safe_cast(time as int64))
        else timestamp_seconds(safe_cast(time as int64))
    end                                                               as event_time,

    -- Common Mixpanel super-properties (set on every event).
    -- TODO: verify these column names — tap-mixpanel may emit them
    -- under different paths (e.g. `properties.os` vs `os`).
    os,
    browser,
    device,
    city,
    region,
    country_code                                                      as country,

    -- Raw properties JSON for everything else.
    properties

from raw
