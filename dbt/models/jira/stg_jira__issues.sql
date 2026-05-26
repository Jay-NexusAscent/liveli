{{
  config(
    materialized = 'view',
    description = 'Cleaned view over tap-jira issues — extract common fields from nested JSON, normalise status + priority.'
  )
}}

with raw as (
    select * from {{ source('jira', 'issues') }}
)

select
    id                                                                as issue_id,
    `key`                                                             as issue_key,           -- e.g. "PROJ-123"

    -- Most fields are under the nested `fields` object.
    safe_cast(json_value(fields, '$.summary') as string)              as summary,
    safe_cast(json_value(fields, '$.issuetype.name') as string)       as issue_type,
    safe_cast(json_value(fields, '$.status.name') as string)          as status_name,
    safe_cast(json_value(fields, '$.status.statusCategory.name') as string) as status_category,    -- "To Do" / "In Progress" / "Done"
    safe_cast(json_value(fields, '$.priority.name') as string)        as priority,

    safe_cast(json_value(fields, '$.project.key') as string)          as project_key,
    safe_cast(json_value(fields, '$.project.id') as string)           as project_id,

    safe_cast(json_value(fields, '$.assignee.accountId') as string)   as assignee_id,
    safe_cast(json_value(fields, '$.assignee.displayName') as string) as assignee_name,
    safe_cast(json_value(fields, '$.reporter.accountId') as string)   as reporter_id,
    safe_cast(json_value(fields, '$.reporter.displayName') as string) as reporter_name,

    -- Story points — often a custom field. Common custom-field IDs
    -- for story points are customfield_10016 / 10026 / 10020 depending
    -- on the Jira instance's age. May need a per-tenant override later.
    coalesce(
      safe_cast(json_value(fields, '$.customfield_10016') as numeric),
      safe_cast(json_value(fields, '$.customfield_10026') as numeric)
    )                                                                 as story_points,

    -- Derived "done" flag — status category is more stable than name.
    safe_cast(json_value(fields, '$.status.statusCategory.name') as string) = 'Done' as is_done,

    safe_cast(json_value(fields, '$.created') as timestamp)           as created_at,
    safe_cast(json_value(fields, '$.updated') as timestamp)           as updated_at,
    safe_cast(json_value(fields, '$.resolutiondate') as timestamp)    as resolved_at

from raw
