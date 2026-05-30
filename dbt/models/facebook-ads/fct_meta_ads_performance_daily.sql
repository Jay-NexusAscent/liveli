{{
  config(
    materialized = 'table',
    description = 'Daily ad-performance fact at ad grain for Meta Ads. Same shape as fct_ad_performance_daily for Google Ads — facilitates a future cross-platform marketing model.',
    cluster_by = ['report_date']
  )
}}

select
    report_date,
    account_id,
    campaign_id,
    campaign_name,
    adset_id,
    adset_name,
    ad_id,
    ad_name,

    spend,
    impressions,
    clicks,
    reach,
    frequency,
    ctr,
    cpc,
    cpm,
    cost_per_thousand_people_reached,

    -- Marketing-platform tag for cross-source roll-ups when we have
    -- both Google + Meta loaded ("show me total ad spend across all
    -- platforms" queries).
    'meta'                                                            as ad_platform

from {{ ref('stg_facebook__ads_insights') }}
