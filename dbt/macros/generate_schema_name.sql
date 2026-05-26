{#
    Override dbt's default schema-naming so EVERY model writes to
    target.schema directly (the per-customer dataset), with NO suffix
    appended.

    Default behaviour:
      schema: "ga4" → dbt writes to <target.schema>_ga4
      schema: null  → dbt writes to <target.schema>

    Override behaviour:
      schema: anything → dbt writes to <target.schema>

    Why this matters: the customer's per-connector dataset is named
    `c_<C>__w_<W>__d_<conn>`. We want fct_/dim_/stg_ tables there
    alongside the raw tap output. Default dbt schema-naming would
    push them into a separate dataset like `c_..._ga4` which (a)
    doesn't exist and would need provisioning, and (b) breaks the
    single-dataset model we agreed on (see LIVELI-54).
#}
{% macro generate_schema_name(custom_schema_name, node) -%}
    {{ target.schema }}
{%- endmacro %}
