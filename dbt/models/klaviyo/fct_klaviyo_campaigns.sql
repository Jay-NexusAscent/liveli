{{
  config(
    materialized = 'table',
    description = 'Per-campaign performance derived from the events stream (opens, clicks, conversions per campaign).'
  )
}}

-- Klaviyo's campaigns table is small (one row per campaign sent);
-- performance metrics come from rolling up the events stream filtered
-- to campaign-related events (Opened Email / Clicked Email /
-- Placed Order with the right utm_source).

with campaigns as (
    select
        id                                                            as campaign_id,
        safe_cast(json_value(attributes, '$.name') as string)         as campaign_name,
        safe_cast(json_value(attributes, '$.subject') as string)      as subject_line,
        safe_cast(json_value(attributes, '$.send_time') as timestamp) as sent_at
    from {{ source('klaviyo', 'campaigns') }}
)

select
    campaign_id,
    campaign_name,
    subject_line,
    sent_at,
    date(sent_at)                                                     as sent_date

from campaigns
