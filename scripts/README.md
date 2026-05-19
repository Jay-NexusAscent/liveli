# scripts

## `seed-retail-data.sql`

Drops the trivial `users` + `orders` tables and replaces them with a
realistic retail schema (~5M rows over 2 years) for testing the
Postgres → BigQuery connector + the agent against meaningful data.

### Schema created

```
customers        50,000     2-year signup spread, weighted GB/US/EU
categories       30         6 parents + 24 children
products         5,000      across 30 categories, £5–£300 price range
orders           500,000    ~700/day, status mix (completed/refunded/cancelled)
order_items      ~1.5M      1–5 items per order
sessions         2,000,000  ~2,700/day, 30% conversion, UTM-attributed
product_reviews  100,000    rating skewed 4–5★, 80% verified
shipments        480,000    7 carriers, status mix
returns          40,000     8% return rate, 10 reasons
```

Total ≈ 4.7M rows. Foreign keys are added *after* the bulk inserts so
loading stays fast.

### How to run

Get your Neon connection string from the Neon dashboard (Connection
Details → "Connection string" → choose the **direct** endpoint, not
the pooled one — pooled drops long-running transactions).

```bash
psql 'postgresql://neondb_owner:...@ep-...neon.tech/neondb?sslmode=require' \
  -f scripts/seed-retail-data.sql
```

`\timing on` is enabled in the file so you'll see per-statement
durations.

### Expected runtime

| Step                 | Rows      | Neon Free | Neon Paid |
|----------------------|-----------|-----------|-----------|
| Schema + categories  | 30        | <1s       | <1s       |
| Products             | 5,000     | 1s        | <1s       |
| Customers            | 50,000    | 5s        | 2s        |
| Orders               | 500,000   | 60s       | 25s       |
| Order items          | ~1.5M     | 3m        | 60s       |
| Sessions             | 2,000,000 | 4m        | 90s       |
| Reviews + shipments + returns | ~620k | 90s | 35s    |
| FKs + indexes        | —         | 2m        | 45s       |

Total: 12–15 min on Free tier, 4–6 min on Paid.

### If it fails halfway

Each major insert is in its own transaction. To resume from after the
last successful step, comment out the earlier sections and re-run. The
final `ANALYZE` + row-count query can be run independently anytime.

### After loading

The Liveli Postgres connector picks the data up automatically on its
next scheduled sync (every hour by default) or via "Sync now" in the
UI. With the new `filter_schemas: ["public"]` default, only the tables
above land in BigQuery — no `information_schema` or `pg_catalog` noise.

### Useful agent queries to try once synced

- "What's our top selling category?"
- "How has revenue trended over the last 12 months?"
- "Which customers spent the most? Show me the top 20."
- "What's our cart abandonment rate?"
- "Compare conversion by marketing channel."
- "Which products have the lowest review ratings?"
- "What's our return rate by category?"
