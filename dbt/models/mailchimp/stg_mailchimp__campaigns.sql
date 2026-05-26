{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-mailchimp campaigns.'
  )
}}

with raw as (
    select * from {{ source('mailchimp', 'campaigns') }}
)

select
    id                                                                as campaign_id,
    type                                                              as campaign_type,           -- regular / plaintext / ab_split / variate
    status,
    web_id                                                            as mailchimp_web_id,

    safe_cast(json_value(recipients, '$.list_id') as string)          as list_id,
    safe_cast(json_value(recipients, '$.recipient_count') as int64)   as recipient_count,

    safe_cast(json_value(settings, '$.subject_line') as string)       as subject_line,
    safe_cast(json_value(settings, '$.from_name') as string)          as from_name,
    safe_cast(json_value(settings, '$.reply_to') as string)           as reply_to,

    safe_cast(create_time as timestamp)                               as created_at,
    safe_cast(send_time as timestamp)                                 as sent_at,

    -- Headline metrics often nested under report_summary.
    safe_cast(json_value(report_summary, '$.opens') as int64)         as opens,
    safe_cast(json_value(report_summary, '$.unique_opens') as int64)  as unique_opens,
    safe_cast(json_value(report_summary, '$.open_rate') as numeric)   as open_rate,
    safe_cast(json_value(report_summary, '$.clicks') as int64)        as clicks,
    safe_cast(json_value(report_summary, '$.subscriber_clicks') as int64) as unique_clicks,
    safe_cast(json_value(report_summary, '$.click_rate') as numeric)  as click_rate

from raw
