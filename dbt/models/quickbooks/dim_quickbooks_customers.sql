{{
  config(
    materialized = 'table',
    description = 'QuickBooks customers with lifetime invoice aggregates — outstanding AR balance, total billed.'
  )
}}

with customers as (
    select
        Id                                                            as customer_id,
        DisplayName                                                   as display_name,
        CompanyName                                                   as company_name,
        safe_cast(json_value(PrimaryEmailAddr, '$.Address') as string) as email,
        safe_cast(Balance as numeric)                                 as qb_current_balance,           -- QB's pre-computed
        Active                                                        as is_active,

        safe_cast(json_value(MetaData, '$.CreateTime') as timestamp)  as created_at

    from {{ source('quickbooks', 'Customer') }}
),

invoice_aggs as (
    select
        customer_id,
        count(*)                                                      as lifetime_invoice_count,
        sum(total_amount)                                             as lifetime_total_billed,
        sum(amount_paid)                                              as lifetime_total_paid,
        sum(balance_remaining)                                        as current_outstanding,
        max(invoice_date)                                             as last_invoice_date

    from {{ ref('fct_invoices') }}
    where customer_id is not null
    group by customer_id
)

select
    c.customer_id,
    c.display_name,
    c.company_name,
    c.email,
    c.is_active,
    c.created_at,

    c.qb_current_balance,                                             -- QuickBooks' own outstanding-balance computation
    coalesce(i.current_outstanding, 0)                                as derived_outstanding,
    coalesce(i.lifetime_invoice_count, 0)                             as lifetime_invoice_count,
    coalesce(i.lifetime_total_billed, 0)                              as lifetime_total_billed,
    coalesce(i.lifetime_total_paid, 0)                                as lifetime_total_paid,
    i.last_invoice_date

from customers c
left join invoice_aggs i using (customer_id)
