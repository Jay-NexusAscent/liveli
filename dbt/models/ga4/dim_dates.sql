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

-- Bounds come from website_overview, not traffic_sources: the latter
-- carries source/medium dimensions and is subject to GA4 low-traffic
-- thresholding, so it can be empty (it is, for this customer). An empty
-- bounds source collapses min/max to NULL → coalesce to today → a spine
-- that starts today and misses all historical data. website_overview has
-- no source dimensions, isn't thresholded, and is the reliably-populated
-- one-row-per-day table — the correct basis for the spine's date range.
with bounds as (
    select
        coalesce(min(event_date), current_date())                     as start_date,
        date_add(coalesce(max(event_date), current_date()), interval 365 day) as end_date
    from {{ ref('stg_ga4__website_overview') }}
),

-- Generate the spine inline with GENERATE_DATE_ARRAY rather than the
-- dbt_utils.date_spine macro: that macro wraps its output in its own
-- WITH clause, and when inlined as this CTE BigQuery loses visibility of
-- the outer `bounds` CTE, falling back to treating it as a physical table
-- ("Table 'bounds' must be qualified with a dataset"). Cross-joining the
-- single-row bounds CTE to the unnested array keeps `bounds` in scope.
date_spine as (
    select date_day
    from bounds,
         unnest(generate_date_array(start_date, end_date, interval 1 day)) as date_day
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
