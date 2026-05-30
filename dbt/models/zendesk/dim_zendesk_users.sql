{{
  config(
    materialized = 'table',
    description = 'Zendesk users (agents + end-users) with role flags.'
  )
}}

select
    id                                                                as user_id,
    name,
    email,
    `role`                                                            as user_role,                 -- end-user / agent / admin
    `active`                                                          as is_active,
    organization_id,
    safe_cast(created_at as timestamp)                                as created_at,

    -- Convenience flags
    `role` in ('agent', 'admin')                                      as is_agent,
    `role` = 'end-user'                                               as is_customer

from {{ source('zendesk', 'users') }}
