{{
  config(
    materialized = 'table',
    description = 'Distinct (source, medium, source_platform) combinations seen across the entire history. Used as a lookup dimension for fct_traffic_daily; small (typically <500 rows even for high-traffic sites).'
  )
}}

-- Why a separate dim table: lets the agent answer "what acquisition
-- channels do I have data for?" without aggregating a multi-million-row
-- fact table. Tiny — fits in a single BQ slot.

with traffic as (
    select * from {{ ref('stg_ga4__traffic_sources') }}
)

select distinct
    source,
    medium,
    source_platform,

    -- Surrogate key — useful when joining from facts to allow the
    -- agent / future models to reference a single column rather than
    -- the (source, medium, platform) triple. dbt-utils generates a
    -- deterministic hash so the same combo always gets the same id.
    {{ dbt_utils.generate_surrogate_key(['source', 'medium', 'source_platform']) }} as source_key,

    -- Convenience label for charts: "google / cpc" rather than two
    -- separate columns the agent has to concat.
    source || ' / ' || medium                                          as source_label

from traffic
