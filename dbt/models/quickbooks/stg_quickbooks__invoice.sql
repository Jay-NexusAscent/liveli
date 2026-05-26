{{
  config(
    materialized = 'view',
    description = 'Cleaned view over QuickBooks Invoice records — header-level fields cast, customer ref extracted from nested object.'
  )
}}

with raw as (
    select * from {{ source('quickbooks', 'Invoice') }}
)

select
    Id                                                                as invoice_id,
    DocNumber                                                         as invoice_number,

    -- CustomerRef is nested as {"value": "123", "name": "Acme Co"}.
    -- Extract the id for joining to dim_customers.
    safe_cast(json_value(CustomerRef, '$.value') as string)           as customer_id,
    safe_cast(json_value(CustomerRef, '$.name') as string)            as customer_name,

    safe_cast(TotalAmt as numeric)                                    as total_amount,
    safe_cast(Balance as numeric)                                     as balance_remaining,
    safe_cast(TotalAmt as numeric) - safe_cast(Balance as numeric)    as amount_paid,

    -- Derived status flags from balance.
    safe_cast(Balance as numeric) <= 0                                as is_paid,
    safe_cast(Balance as numeric) > 0 and safe_cast(Balance as numeric) < safe_cast(TotalAmt as numeric) as is_partially_paid,

    -- Currency from nested CurrencyRef.
    safe_cast(json_value(CurrencyRef, '$.value') as string)           as currency,

    safe_cast(TxnDate as date)                                        as invoice_date,
    safe_cast(DueDate as date)                                        as due_date,

    -- Aging: how many days past due (negative = days until due for unpaid).
    case
        when safe_cast(Balance as numeric) > 0 then date_diff(current_date(), safe_cast(DueDate as date), day)
        else null
    end                                                               as days_past_due,

    PrivateNote                                                       as internal_note,
    EmailStatus                                                       as email_status,

    safe_cast(json_value(MetaData, '$.CreateTime') as timestamp)      as created_at,
    safe_cast(json_value(MetaData, '$.LastUpdatedTime') as timestamp) as updated_at

from raw
