{{
  config(
    materialized = 'table',
    description = 'Mailchimp subscriber lists with subscriber-count snapshots.'
  )
}}

select
    id                                                                as list_id,
    name                                                              as list_name,
    safe_cast(json_value(stats, '$.member_count') as int64)           as member_count,
    safe_cast(json_value(stats, '$.unsubscribe_count') as int64)      as unsubscribe_count,
    safe_cast(json_value(stats, '$.cleaned_count') as int64)          as cleaned_count,
    safe_cast(json_value(stats, '$.open_rate') as numeric)            as list_avg_open_rate,
    safe_cast(json_value(stats, '$.click_rate') as numeric)           as list_avg_click_rate,
    safe_cast(date_created as timestamp)                              as created_at

from {{ source('mailchimp', 'lists') }}
