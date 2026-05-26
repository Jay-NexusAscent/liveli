{{
  config(
    materialized = 'table',
    description = 'Salesforce accounts with lifetime opportunity aggregates rolled up from fct_opportunities.'
  )
}}

with accounts as (
    select
        Id                                                            as account_id,
        Name                                                          as account_name,
        Type                                                          as account_type,
        Industry                                                      as industry,
        AnnualRevenue                                                 as annual_revenue,
        BillingCountry                                                as billing_country,
        OwnerId                                                       as owner_id,

        safe_cast(CreatedDate as timestamp)                           as created_at,
        safe_cast(LastModifiedDate as timestamp)                      as updated_at

    from {{ source('salesforce', 'account') }}
),

opp_aggs as (
    select
        account_id,
        count(*)                                                      as opportunity_count,
        countif(is_won)                                               as won_opportunity_count,
        countif(is_lost)                                              as lost_opportunity_count,
        countif(not is_closed)                                        as open_opportunity_count,
        sum(if(is_won, amount, 0))                                    as lifetime_won_amount,
        sum(if(not is_closed, weighted_amount, 0))                    as open_pipeline_weighted,
        max(if(is_won, close_date, null))                             as last_won_date

    from {{ ref('fct_opportunities') }}
    where account_id is not null
    group by account_id
)

select
    a.account_id,
    a.account_name,
    a.account_type,
    a.industry,
    a.annual_revenue,
    a.billing_country,
    a.owner_id,
    a.created_at,

    coalesce(o.opportunity_count, 0)                                  as opportunity_count,
    coalesce(o.won_opportunity_count, 0)                              as won_opportunity_count,
    coalesce(o.lost_opportunity_count, 0)                             as lost_opportunity_count,
    coalesce(o.open_opportunity_count, 0)                             as open_opportunity_count,
    coalesce(o.lifetime_won_amount, 0)                                as lifetime_won_amount,
    coalesce(o.open_pipeline_weighted, 0)                             as open_pipeline_weighted,
    o.last_won_date,

    coalesce(o.won_opportunity_count, 0) > 0                          as is_customer

from accounts a
left join opp_aggs o using (account_id)
