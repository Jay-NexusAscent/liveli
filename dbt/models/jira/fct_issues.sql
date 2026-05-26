{{
  config(
    materialized = 'table',
    description = 'One row per Jira issue with cycle time + age. Canonical analytical grain for engineering ops questions.',
    cluster_by = ['created_at']
  )
}}

select
    issue_id,
    issue_key,
    summary,
    issue_type,
    status_name,
    status_category,
    priority,
    project_id,
    project_key,
    assignee_id,
    assignee_name,
    reporter_id,
    reporter_name,
    story_points,
    is_done,

    created_at,
    updated_at,
    resolved_at,
    date(created_at)                                                  as created_date,
    date(resolved_at)                                                 as resolved_date,

    -- Cycle time = time-to-resolution (for completed issues).
    -- For open issues this is age-from-creation.
    case
        when is_done and resolved_at is not null
        then date_diff(date(resolved_at), date(created_at), day)
        when not is_done
        then date_diff(current_date(), date(created_at), day)
        else null
    end                                                               as cycle_time_days

from {{ ref('stg_jira__issues') }}
