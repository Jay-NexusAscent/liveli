{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-intercom conversations — flatten nested participant + state fields.'
  )
}}

with raw as (
    select * from {{ source('intercom', 'conversations') }}
)

select
    id                                                                as conversation_id,

    -- State + open status
    `state`                                                           as conversation_state,    -- open / closed / snoozed
    safe_cast(`open` as bool)                                         as is_open,
    safe_cast(`read` as bool)                                         as is_read,
    priority,

    -- Contact / admin references (nested JSON in tap output).
    safe_cast(json_value(source, '$.author.id') as string)            as initial_author_id,
    safe_cast(json_value(source, '$.author.type') as string)          as initial_author_type,   -- user / admin / bot

    -- Conversation rating (set by user after closure)
    safe_cast(json_value(conversation_rating, '$.rating') as int64)   as customer_rating,

    -- SLA + timing metrics (Intercom pre-computes some of these)
    safe_cast(json_value(statistics, '$.first_admin_reply_at') as timestamp) as first_admin_reply_at,
    safe_cast(json_value(statistics, '$.last_admin_reply_at') as timestamp)  as last_admin_reply_at,
    safe_cast(json_value(statistics, '$.last_close_at') as timestamp)        as last_close_at,
    safe_cast(json_value(statistics, '$.median_time_to_reply') as numeric)   as median_time_to_reply_seconds,

    safe_cast(created_at as timestamp)                                as created_at,
    safe_cast(updated_at as timestamp)                                as updated_at

from raw
