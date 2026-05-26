{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-hubspot deals — extract common properties from the nested JSON, cast amounts, derive lifecycle flags.'
  )
}}

with raw as (
    select * from {{ source('hubspot', 'deals') }}
)

select
    id                                                                as deal_id,
    safe_cast(json_value(properties, '$.dealname') as string)         as deal_name,
    safe_cast(json_value(properties, '$.amount') as numeric)          as amount,
    safe_cast(json_value(properties, '$.dealstage') as string)        as deal_stage,
    safe_cast(json_value(properties, '$.pipeline') as string)         as pipeline_id,
    safe_cast(json_value(properties, '$.dealtype') as string)         as deal_type,
    safe_cast(json_value(properties, '$.hubspot_owner_id') as string) as owner_id,

    -- Closed-state flags. HubSpot uses specific stage names; we
    -- normalise to is_won / is_lost / is_open based on the conventional
    -- pipeline stages. May need refinement per-customer (custom pipelines
    -- with different stage names won't match this exactly).
    coalesce(safe_cast(json_value(properties, '$.dealstage') as string), '')
      like '%closedwon%'                                              as is_won,
    coalesce(safe_cast(json_value(properties, '$.dealstage') as string), '')
      like '%closedlost%'                                             as is_lost,

    safe_cast(json_value(properties, '$.closedate') as timestamp)     as close_date,
    safe_cast(json_value(properties, '$.createdate') as timestamp)    as created_at,
    safe_cast(json_value(properties, '$.hs_lastmodifieddate') as timestamp) as updated_at

from raw
