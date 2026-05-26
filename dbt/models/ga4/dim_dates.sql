{{
  config(
    materialized = 'table',
    description = 'Date spine covering the range of GA4 data we have, plus a year forward (for fact-table joins). Use this as the LHS of left joins to avoid gaps in time-series queries.'
  )
}}

-- Why generate dynamically rather than hardcode: customer GA4
-- properties have different start dates; using the actual data range
-- avoids both (a) gaps (if we hardcoded a start that's after the
-- customer's earliest event) and (b) wasted rows (if hardcoded start
-- is decades before any data exists).
--
-- Adds 365 days forward to allow joining to forecasts / projections
-- without breaking the join.

with bounds as (
    select
        coalesce(min(event_date), current_date())                     as start_date,
        date_add(coalesce(max(event_date), current_date()), interval 365 day) as end_date
    from {{ ref('stg_ga4__traffic_sources') }}
),

date_spine as (
    {{ dbt_utils.date_spine(
        datepart="day",
        start_date="(select start_date from bounds)",
        end_date="(select end_date from bounds)"
    ) }}
)

select
    date_day                                                          as date,
    extract(year from date_day)                                       as year,
    extract(quarter from date_day)                                    as quarter,
    extract(month from date_day)                                      as month,
    extract(week from date_day)                                       as week_of_year,
    extract(day from date_day)                                        as day_of_month,
    extract(dayofweek from date_day)                                  as day_of_week,        -- 1=Sunday … 7=Saturday in BQ
    format_date('%A', date_day)                                       as day_name,           -- "Monday"
    format_date('%B', date_day)                                       as month_name,         -- "March"
    date_day = current_date()                                         as is_today,
    date_day < current_date()                                         as is_past,
    date_day > current_date()                                         as is_future

from date_spine
