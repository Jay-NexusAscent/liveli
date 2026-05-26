{{
  config(
    materialized = 'view',
    description = 'Cleaned view over Salesforce opportunities — type-cast money, normalise stage flags.'
  )
}}

with raw as (
    select * from {{ source('salesforce', 'opportunity') }}
)

select
    Id                                                                as opportunity_id,
    Name                                                              as opportunity_name,
    AccountId                                                         as account_id,
    OwnerId                                                           as owner_id,

    safe_cast(Amount as numeric)                                      as amount,
    StageName                                                         as stage_name,
    safe_cast(Probability as numeric)                                 as probability_pct,
    LeadSource                                                        as lead_source,
    Type                                                              as opportunity_type,

    -- Salesforce gives us IsClosed and IsWon as authoritative flags —
    -- safer than parsing StageName which varies per org.
    safe_cast(IsClosed as bool)                                       as is_closed,
    safe_cast(IsWon as bool)                                          as is_won,
    coalesce(safe_cast(IsClosed as bool), false)
      and not coalesce(safe_cast(IsWon as bool), false)               as is_lost,

    safe_cast(CloseDate as date)                                      as close_date,
    safe_cast(CreatedDate as timestamp)                               as created_at,
    safe_cast(LastModifiedDate as timestamp)                          as updated_at

from raw
