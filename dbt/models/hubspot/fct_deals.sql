{{
  config(
    materialized = 'table',
    description = 'One row per HubSpot deal with derived pipeline state + age. Cluster on close_date for "deals closing this quarter" queries.',
    cluster_by = ['close_date']
  )
}}

select
    deal_id,
    deal_name,
    amount,
    deal_stage,
    pipeline_id,
    deal_type,
    owner_id,

    is_won,
    is_lost,
    case
        when is_won then 'won'
        when is_lost then 'lost'
        else 'open'
    end                                                               as deal_outcome,

    -- Age in days. For open deals it's age-from-creation; for closed
    -- deals it's time-to-close.
    date_diff(
      coalesce(close_date, current_timestamp()),
      created_at,
      day
    )                                                                 as deal_age_days,

    created_at,
    close_date,
    updated_at,
    date(created_at)                                                  as created_date,
    date(close_date)                                                  as close_date_only

from {{ ref('stg_hubspot__deals') }}
