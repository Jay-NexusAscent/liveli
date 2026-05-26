{{
  config(
    materialized = 'table',
    description = 'One row per Salesforce opportunity with derived sales-cycle metrics.',
    cluster_by = ['close_date']
  )
}}

select
    opportunity_id,
    opportunity_name,
    account_id,
    owner_id,

    amount,
    stage_name,
    probability_pct,
    -- Weighted pipeline value — useful for forecasting.
    amount * coalesce(probability_pct, 0) / 100.0                     as weighted_amount,

    lead_source,
    opportunity_type,

    is_closed,
    is_won,
    is_lost,
    case
        when is_won then 'won'
        when is_lost then 'lost'
        else 'open'
    end                                                               as opportunity_outcome,

    -- Sales cycle length in days (close - create). For open opps, age
    -- from creation to now.
    date_diff(
      coalesce(close_date, current_date()),
      date(created_at),
      day
    )                                                                 as days_in_pipeline,

    created_at,
    close_date,
    updated_at

from {{ ref('stg_salesforce__opportunity') }}
