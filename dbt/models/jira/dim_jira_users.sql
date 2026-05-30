{{
  config(
    materialized = 'table',
    description = 'Jira users with current workload aggregates from issues — useful for capacity-planning queries.'
  )
}}

with users as (
    select
        accountId                                                     as user_id,
        displayName                                                   as display_name,
        emailAddress                                                  as email,
        active                                                        as is_active,
        timeZone                                                      as timezone

    from {{ source('jira', 'users') }}
),

workload as (
    select
        assignee_id                                                   as user_id,
        countif(not is_done)                                          as open_issue_count,
        countif(is_done)                                              as completed_issue_count,
        sum(if(not is_done, coalesce(story_points, 0), 0))            as open_story_points,
        avg(if(is_done, cycle_time_days, null))                       as avg_cycle_time_days

    from {{ ref('fct_issues') }}
    where assignee_id is not null
    group by user_id
)

select
    u.user_id,
    u.display_name,
    u.email,
    u.is_active,
    u.timezone,

    coalesce(w.open_issue_count, 0)                                   as open_issue_count,
    coalesce(w.completed_issue_count, 0)                              as completed_issue_count,
    coalesce(w.open_story_points, 0)                                  as open_story_points,
    w.avg_cycle_time_days

from users u
left join workload w using (user_id)
