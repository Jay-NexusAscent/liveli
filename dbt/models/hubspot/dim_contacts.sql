{{
  config(
    materialized = 'table',
    description = 'HubSpot contacts with key lifecycle properties extracted from the nested JSON.'
  )
}}

select
    id                                                                as contact_id,
    safe_cast(json_value(properties, '$.email') as string)            as email,
    safe_cast(json_value(properties, '$.firstname') as string)        as first_name,
    safe_cast(json_value(properties, '$.lastname') as string)         as last_name,
    safe_cast(json_value(properties, '$.company') as string)          as company_name,
    safe_cast(json_value(properties, '$.lifecyclestage') as string)   as lifecycle_stage,
    safe_cast(json_value(properties, '$.lead_status') as string)      as lead_status,
    safe_cast(json_value(properties, '$.hs_lead_status') as string)   as hs_lead_status,
    safe_cast(json_value(properties, '$.hubspot_owner_id') as string) as owner_id,

    safe_cast(json_value(properties, '$.createdate') as timestamp)    as created_at,
    safe_cast(json_value(properties, '$.lastmodifieddate') as timestamp) as updated_at

from {{ source('hubspot', 'contacts') }}
