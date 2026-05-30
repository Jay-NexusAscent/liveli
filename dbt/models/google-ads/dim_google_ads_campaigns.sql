{{
  config(
    materialized = 'table',
    description = 'Distinct campaigns seen, with current status and basic metadata. Small dim for joining facts.'
  )
}}

-- Reads from the campaign entity table OR derived from the performance
-- report — both available. Using performance report so this stays in
-- sync even if the entity table lags.

select distinct
    campaign_id,
    campaign_name,
    campaign_status,
    advertising_channel_type

from {{ ref('stg_googleads__campaign_performance') }}
where campaign_id is not null
