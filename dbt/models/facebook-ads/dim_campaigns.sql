{{
  config(
    materialized = 'table',
    description = 'Distinct campaigns seen in Meta Ads insights, with names. Small dim for joining.'
  )
}}

select distinct
    campaign_id,
    campaign_name,
    account_id

from {{ ref('stg_facebook__ads_insights') }}
where campaign_id is not null
