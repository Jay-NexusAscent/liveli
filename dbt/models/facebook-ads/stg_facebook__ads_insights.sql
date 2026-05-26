{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-facebook ads_insights — cast money + counts, normalise date format.'
  )
}}

with raw as (
    select * from {{ source('facebook', 'ads_insights') }}
)

select
    safe_cast(date_start as date)                                     as report_date,

    safe_cast(account_id as string)                                   as account_id,
    safe_cast(campaign_id as string)                                  as campaign_id,
    campaign_name,
    safe_cast(adset_id as string)                                     as adset_id,
    adset_name,
    safe_cast(ad_id as string)                                        as ad_id,
    ad_name,

    -- Meta returns spend as a string in major currency units ("12.34").
    safe_cast(spend as numeric)                                       as spend,
    safe_cast(impressions as int64)                                   as impressions,
    safe_cast(clicks as int64)                                        as clicks,
    safe_cast(reach as int64)                                         as reach,
    safe_cast(frequency as numeric)                                   as frequency,
    safe_cast(ctr as numeric)                                         as ctr,
    safe_cast(cpc as numeric)                                         as cpc,
    safe_cast(cpm as numeric)                                         as cpm,
    safe_cast(cpp as numeric)                                         as cost_per_thousand_people_reached

from raw
