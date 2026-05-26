{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-googleads campaign_performance_report — money normalised from micros to major units, dates cast.'
  )
}}

with raw as (
    select * from {{ source('googleads', 'campaign_performance_report') }}
)

select
    -- Date from `segments_date` column convention. Verify after sync.
    safe_cast(segments_date as date)                                  as report_date,

    safe_cast(campaign_id as string)                                  as campaign_id,
    campaign_name,
    campaign_status,
    campaign_advertising_channel_type                                 as advertising_channel_type,

    -- Google Ads returns cost in micros (1 USD = 1,000,000 micros).
    -- Divide for major-unit reporting; keep micros for exact aggregation.
    safe_cast(metrics_cost_micros as int64)                           as cost_micros,
    safe_divide(safe_cast(metrics_cost_micros as int64), 1000000.0)   as cost,

    safe_cast(metrics_clicks as int64)                                as clicks,
    safe_cast(metrics_impressions as int64)                           as impressions,
    safe_cast(metrics_conversions as numeric)                         as conversions,
    safe_cast(metrics_conversions_value as numeric)                   as conversions_value,

    -- Derived performance rates
    safe_divide(metrics_clicks, metrics_impressions)                  as ctr,
    safe_divide(metrics_cost_micros / 1000000.0, metrics_clicks)      as cpc,
    safe_divide(metrics_conversions, metrics_clicks)                  as conversion_rate

from raw
