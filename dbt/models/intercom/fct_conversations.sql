{{
  config(
    materialized = 'table',
    description = 'One row per Intercom conversation with derived SLA / response-time metrics.',
    cluster_by = ['created_at']
  )
}}

select
    conversation_id,
    conversation_state,
    is_open,
    is_read,
    priority,
    initial_author_id,
    initial_author_type,
    customer_rating,

    first_admin_reply_at,
    last_admin_reply_at,
    last_close_at,
    median_time_to_reply_seconds,

    -- Derived first-response time (seconds from creation to first admin reply).
    timestamp_diff(first_admin_reply_at, created_at, second)          as first_response_time_seconds,

    -- Time to resolution (creation → last_close_at) for closed convos.
    timestamp_diff(last_close_at, created_at, second)                 as time_to_resolution_seconds,

    -- SLA flags — first response in <1h is a common benchmark.
    timestamp_diff(first_admin_reply_at, created_at, second) <= 3600  as met_one_hour_sla,

    created_at,
    updated_at,
    date(created_at)                                                  as created_date

from {{ ref('stg_intercom__conversations') }}
