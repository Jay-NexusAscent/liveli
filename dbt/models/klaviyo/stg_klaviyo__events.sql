{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-klaviyo events — flatten metric name + profile reference.'
  )
}}

with raw as (
    select * from {{ source('klaviyo', 'events') }}
)

select
    id                                                                as event_id,

    -- Each event has a `metric` (event-type, e.g. "Placed Order",
    -- "Opened Email") and a `profile` (the user).
    safe_cast(json_value(metric, '$.name') as string)                 as event_name,
    safe_cast(json_value(metric, '$.id') as string)                   as event_metric_id,
    safe_cast(json_value(profile, '$.id') as string)                  as profile_id,
    safe_cast(json_value(profile, '$.email') as string)               as profile_email,

    -- Event value — often the monetary value for "Placed Order" events.
    safe_cast(event_properties as string)                             as event_properties_json,
    safe_cast(json_value(event_properties, '$.value') as numeric)     as event_value,

    safe_cast(timestamp as timestamp)                                 as event_time

from raw
