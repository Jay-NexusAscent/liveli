{{
  config(
    materialized = 'table',
    description = 'Per-campaign performance fact — opens, clicks, derived engagement rate.',
    cluster_by = ['sent_at']
  )
}}

select
    campaign_id,
    campaign_type,
    status,
    list_id,
    subject_line,
    from_name,
    sent_at,
    date(sent_at)                                                     as sent_date,
    created_at,

    recipient_count,
    opens,
    unique_opens,
    open_rate,
    clicks,
    unique_clicks,
    click_rate,

    -- Engagement = unique-opens divided by recipients (Mailchimp's
    -- open_rate excludes auto-opens; sometimes diverges from this).
    safe_divide(unique_opens, recipient_count)                        as derived_open_rate,
    safe_divide(unique_clicks, recipient_count)                       as derived_click_rate,
    safe_divide(unique_clicks, unique_opens)                          as click_to_open_rate

from {{ ref('stg_mailchimp__campaigns') }}
where status = 'sent'                              -- exclude drafts / scheduled
