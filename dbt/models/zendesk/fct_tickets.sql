{{
  config(
    materialized = 'table',
    description = 'One row per Zendesk ticket with derived age + SLA flags.',
    cluster_by = ['created_at']
  )
}}

select
    ticket_id,
    subject,
    ticket_status,
    ticket_type,
    priority,
    assignee_id,
    submitter_id,
    requester_id,
    organization_id,
    group_id,
    brand_id,
    is_resolved,
    is_closed,
    satisfaction_score,

    created_at,
    updated_at,
    date(created_at)                                                  as created_date,

    -- Ticket age in hours.
    -- For unresolved: hours since creation (still open).
    -- For resolved: time-to-resolution (created → last updated, which
    --   is the solve event for solved/closed tickets).
    case
        when is_resolved then timestamp_diff(updated_at, created_at, hour)
        else timestamp_diff(current_timestamp(), created_at, hour)
    end                                                               as age_hours,

    -- SLA: high-priority resolved within 24h is a common benchmark.
    is_resolved
      and priority in ('high', 'urgent')
      and timestamp_diff(updated_at, created_at, hour) <= 24          as met_high_priority_sla

from {{ ref('stg_zendesk__tickets') }}
