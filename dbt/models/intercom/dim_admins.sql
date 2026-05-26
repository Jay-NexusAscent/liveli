{{
  config(
    materialized = 'table',
    description = 'Intercom admins (support agents) with current workload aggregates.'
  )
}}

select
    id                                                                as admin_id,
    name                                                              as admin_name,
    email,
    `type`                                                            as admin_type,
    away_mode_enabled                                                 as is_away

from {{ source('intercom', 'admins') }}
