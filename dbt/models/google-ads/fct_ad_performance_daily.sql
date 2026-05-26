{{
  config(
    materialized = 'table',
    description = 'Daily ad-performance fact at campaign grain — the canonical "show me yesterday\'s Google Ads spend / clicks / conversions" model.',
    cluster_by = ['report_date']
  )
}}

select
    report_date,
    campaign_id,
    campaign_name,
    campaign_status,
    advertising_channel_type,

    cost,
    cost_micros,
    clicks,
    impressions,
    conversions,
    conversions_value,

    ctr,
    cpc,
    conversion_rate,

    -- Return on ad spend — conversions value per dollar spent.
    safe_divide(conversions_value, cost)                              as roas

from {{ ref('stg_googleads__campaign_performance') }}
