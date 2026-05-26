{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-zendesk tickets.'
  )
}}

with raw as (
    select * from {{ source('zendesk', 'tickets') }}
)

select
    id                                                                as ticket_id,
    `subject`                                                         as subject,
    description,
    `status`                                                          as ticket_status,             -- new / open / pending / hold / solved / closed
    `type`                                                            as ticket_type,               -- problem / incident / question / task
    priority,                                                                                       -- low / normal / high / urgent

    safe_cast(assignee_id as string)                                  as assignee_id,
    safe_cast(submitter_id as string)                                 as submitter_id,
    safe_cast(requester_id as string)                                 as requester_id,
    safe_cast(organization_id as string)                              as organization_id,
    safe_cast(group_id as string)                                     as group_id,
    safe_cast(brand_id as string)                                     as brand_id,

    -- Derived state flags
    `status` in ('solved', 'closed')                                  as is_resolved,
    `status` = 'closed'                                               as is_closed,

    -- Satisfaction rating (set by requester after solve)
    safe_cast(json_value(satisfaction_rating, '$.score') as string)   as satisfaction_score,        -- good / bad / null

    safe_cast(created_at as timestamp)                                as created_at,
    safe_cast(updated_at as timestamp)                                as updated_at

from raw
