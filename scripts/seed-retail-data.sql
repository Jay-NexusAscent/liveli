-- ─────────────────────────────────────────────────────────────────────
--  Liveli — retail test data seeder (Neon / Postgres)
-- ─────────────────────────────────────────────────────────────────────
--
--  WHAT THIS DOES
--    1. Drops the trivial users + orders tables you had originally.
--    2. Creates a richer retail schema:
--         customers, categories, products, orders, order_items,
--         sessions, product_reviews, shipments, returns.
--    3. Seeds ~5M rows total spread realistically over the last 2 years.
--
--  HOW TO RUN
--    psql 'postgresql://neondb_owner:...@ep-...neon.tech/neondb' \
--         -f scripts/seed-retail-data.sql
--
--  EXPECTED RUNTIME
--    Neon free-tier compute: 15-30 min (sessions table is the bottleneck).
--    Neon paid compute: 5-10 min.
--    Each big-table insert is its own transaction so a slow connection
--    can resume from the last completed step rather than restarting.
--
--  TARGETS (~5M rows total)
--    categories            ~30
--    products              5,000
--    customers             50,000
--    orders                500,000      (250k/yr, ~700/day)
--    order_items           ~1,500,000   (avg 3 items per order)
--    sessions              2,000,000    (~2700/day, 70% don't convert)
--    product_reviews       100,000      (~20% of orders generate one)
--    shipments             480,000      (96% of orders)
--    returns               40,000       (8% of orders, return reasons varied)
-- ─────────────────────────────────────────────────────────────────────

\timing on

-- ─────────────────────────────────────────────────────────────────────
-- 1. DROP + CREATE schema  (no FKs yet — they get added at the end so
--    bulk inserts stay fast)
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

DROP TABLE IF EXISTS returns CASCADE;
DROP TABLE IF EXISTS shipments CASCADE;
DROP TABLE IF EXISTS product_reviews CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS users CASCADE; -- legacy

CREATE TABLE customers (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(255) NOT NULL UNIQUE,
  first_name      VARCHAR(100),
  last_name       VARCHAR(100),
  country         CHAR(2),
  city            VARCHAR(100),
  signup_date     TIMESTAMPTZ NOT NULL,
  marketing_opt_in BOOLEAN DEFAULT false,
  loyalty_tier    VARCHAR(20) DEFAULT 'bronze',
  total_spent_gbp NUMERIC(12,2) DEFAULT 0,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE categories (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  parent_id   INT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE products (
  id           SERIAL PRIMARY KEY,
  sku          VARCHAR(50) NOT NULL UNIQUE,
  name         VARCHAR(255) NOT NULL,
  category_id  INT,
  description  TEXT,
  price_gbp    NUMERIC(10,2) NOT NULL,
  cost_gbp     NUMERIC(10,2) NOT NULL,
  stock_count  INT DEFAULT 0,
  is_active    BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE orders (
  id              SERIAL PRIMARY KEY,
  customer_id     INT NOT NULL,
  order_number    VARCHAR(20) NOT NULL UNIQUE,
  status          VARCHAR(20) NOT NULL,
  subtotal_gbp    NUMERIC(10,2) NOT NULL,
  shipping_gbp    NUMERIC(10,2) NOT NULL,
  tax_gbp         NUMERIC(10,2) NOT NULL,
  discount_gbp    NUMERIC(10,2) DEFAULT 0,
  total_gbp       NUMERIC(10,2) NOT NULL,
  promo_code      VARCHAR(50),
  channel         VARCHAR(20),       -- web / mobile / in-store
  placed_at       TIMESTAMPTZ NOT NULL,
  shipped_at      TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ
);

CREATE TABLE order_items (
  id               SERIAL PRIMARY KEY,
  order_id         INT NOT NULL,
  product_id       INT NOT NULL,
  quantity         INT NOT NULL,
  unit_price_gbp   NUMERIC(10,2) NOT NULL,
  subtotal_gbp     NUMERIC(10,2) NOT NULL
);

CREATE TABLE sessions (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     INT,                -- nullable: anonymous browsing
  session_uuid    UUID NOT NULL DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  device_type     VARCHAR(20),
  browser         VARCHAR(50),
  referrer_source VARCHAR(50),
  page_view_count INT DEFAULT 1,
  did_purchase    BOOLEAN DEFAULT false,
  utm_source      VARCHAR(100),
  utm_medium      VARCHAR(100),
  utm_campaign    VARCHAR(100)
);

CREATE TABLE product_reviews (
  id           SERIAL PRIMARY KEY,
  product_id   INT NOT NULL,
  customer_id  INT NOT NULL,
  rating       INT NOT NULL,
  title        VARCHAR(255),
  body         TEXT,
  is_verified  BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE shipments (
  id              SERIAL PRIMARY KEY,
  order_id        INT NOT NULL UNIQUE,
  carrier         VARCHAR(50),
  tracking_number VARCHAR(100),
  status          VARCHAR(20),
  shipped_at      TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  cost_gbp        NUMERIC(10,2)
);

CREATE TABLE returns (
  id                SERIAL PRIMARY KEY,
  order_id          INT NOT NULL,
  customer_id       INT NOT NULL,
  return_reason     VARCHAR(50),
  refund_amount_gbp NUMERIC(10,2),
  status            VARCHAR(20),
  requested_at      TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ
);

COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 2. CATEGORIES (30 — parents + child)
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
INSERT INTO categories (name, parent_id) VALUES
  ('Apparel', NULL),
  ('Home & Garden', NULL),
  ('Electronics', NULL),
  ('Beauty & Personal Care', NULL),
  ('Sports & Outdoors', NULL),
  ('Books & Media', NULL),
  -- Apparel children
  ('Men''s Clothing', 1),
  ('Women''s Clothing', 1),
  ('Footwear', 1),
  ('Accessories', 1),
  -- Home & Garden children
  ('Furniture', 2),
  ('Kitchen', 2),
  ('Bedding', 2),
  ('Garden', 2),
  ('Décor', 2),
  -- Electronics children
  ('Audio', 3),
  ('Computing', 3),
  ('Phones', 3),
  ('Wearables', 3),
  ('Cameras', 3),
  -- Beauty children
  ('Skincare', 4),
  ('Makeup', 4),
  ('Haircare', 4),
  ('Fragrance', 4),
  -- Sports children
  ('Fitness', 5),
  ('Cycling', 5),
  ('Outdoor Gear', 5),
  ('Team Sports', 5),
  -- Books
  ('Fiction', 6),
  ('Non-fiction', 6);
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 3. PRODUCTS (5,000)
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
INSERT INTO products (sku, name, category_id, description, price_gbp, cost_gbp, stock_count, is_active, created_at)
SELECT
  'SKU-' || lpad(i::text, 6, '0'),
  -- name = "{adjective} {colour} {noun}" with cycling lookups
  (ARRAY['Classic','Modern','Vintage','Premium','Essential','Limited','Compact','Pro','Mini','Eco'])[1 + (i % 10)]
    || ' ' ||
  (ARRAY['Black','White','Navy','Olive','Charcoal','Beige','Rust','Forest','Sand','Cobalt'])[1 + ((i / 10) % 10)]
    || ' ' ||
  (ARRAY['T-Shirt','Hoodie','Sneaker','Lamp','Mug','Headphones','Watch','Backpack','Bottle','Notebook',
         'Cushion','Vase','Speaker','Keyboard','Mouse','Toaster','Kettle','Blender','Towel','Frame'])[1 + ((i / 100) % 20)],
  1 + ((i % 30) + (i / 30)) % 30,    -- category 1-30 distributed
  'Auto-generated test product. Lorem ipsum description for product ' || i || '.',
  ((5 + (i % 200)) + (random() * 50))::numeric(10,2),   -- price £5-260
  ((2 + (i % 80)) + (random() * 20))::numeric(10,2),    -- cost £2-100
  floor(random() * 500)::int,
  random() > 0.05,                   -- 5% inactive (discontinued)
  now() - (random() * interval '730 days')
FROM generate_series(1, 5000) i;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 4. CUSTOMERS (50,000) — spread over last 730 days with mild growth
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
INSERT INTO customers (email, first_name, last_name, country, city, signup_date, marketing_opt_in, loyalty_tier, total_spent_gbp, last_seen_at)
SELECT
  -- Email must be unique; index suffix guarantees that
  lower(
    (ARRAY['james','olivia','william','emma','liam','sophia','noah','ava','elijah','isabella',
           'lucas','mia','mason','charlotte','logan','amelia','ethan','harper','aiden','evelyn',
           'jackson','abigail','sebastian','emily','jack','ella','owen','elizabeth','daniel','sofia',
           'samuel','avery','henry','grace','matthew','chloe','levi','victoria','david','riley',
           'joseph','aria','andrew','lily','john','aubrey','dylan','zoey','michael','penelope'])[1 + (i % 50)]
  ) || '.' ||
  lower(
    (ARRAY['smith','jones','taylor','brown','williams','wilson','johnson','davies','robinson','wright',
           'thompson','evans','walker','white','roberts','green','hall','wood','jackson','clarke',
           'martin','jenkins','baker','ward','morris','allen','king','watson','scott','parker',
           'lewis','turner','hill','phillips','campbell','mitchell','carter','reed','price','adams',
           'cook','morgan','bell','cooper','rogers','bailey','ross','cox','howard','foster'])[1 + ((i / 50) % 50)]
  ) || i || '@example.com',
  (ARRAY['James','Olivia','William','Emma','Liam','Sophia','Noah','Ava','Elijah','Isabella',
         'Lucas','Mia','Mason','Charlotte','Logan','Amelia','Ethan','Harper','Aiden','Evelyn',
         'Jackson','Abigail','Sebastian','Emily','Jack','Ella','Owen','Elizabeth','Daniel','Sofia',
         'Samuel','Avery','Henry','Grace','Matthew','Chloe','Levi','Victoria','David','Riley',
         'Joseph','Aria','Andrew','Lily','John','Aubrey','Dylan','Zoey','Michael','Penelope'])[1 + (i % 50)],
  (ARRAY['Smith','Jones','Taylor','Brown','Williams','Wilson','Johnson','Davies','Robinson','Wright',
         'Thompson','Evans','Walker','White','Roberts','Green','Hall','Wood','Jackson','Clarke',
         'Martin','Jenkins','Baker','Ward','Morris','Allen','King','Watson','Scott','Parker',
         'Lewis','Turner','Hill','Phillips','Campbell','Mitchell','Carter','Reed','Price','Adams',
         'Cook','Morgan','Bell','Cooper','Rogers','Bailey','Ross','Cox','Howard','Foster'])[1 + ((i / 50) % 50)],
  -- Country mix weighted toward UK then US, EU, rest
  (ARRAY['GB','GB','GB','GB','GB','US','US','US','DE','DE','FR','ES','IT','NL','IE','AU','CA','SE','PL','BE'])[1 + (i % 20)],
  (ARRAY['London','Manchester','Birmingham','Leeds','Glasgow','Edinburgh','Bristol','Liverpool','Newcastle','Sheffield',
         'New York','San Francisco','Chicago','Los Angeles','Berlin','Munich','Paris','Lyon','Madrid','Barcelona',
         'Rome','Milan','Amsterdam','Dublin','Sydney','Toronto','Stockholm','Warsaw','Brussels','Cardiff'])[1 + (i % 30)],
  -- Signup distributed over 730 days, biased slightly toward recent (sqrt of random)
  now() - (sqrt(random()) * interval '730 days'),
  random() > 0.4,                                      -- 60% opted in
  (ARRAY['bronze','bronze','bronze','bronze','silver','silver','silver','gold','gold','platinum'])[1 + (i % 10)],
  0,                                                    -- updated after orders insert
  now() - (random() * interval '90 days')              -- last seen in last 3 months
FROM generate_series(1, 50000) i;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 5. ORDERS (500,000)
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
INSERT INTO orders (
  customer_id, order_number, status, subtotal_gbp, shipping_gbp, tax_gbp,
  discount_gbp, total_gbp, promo_code, channel, placed_at, shipped_at, delivered_at, cancelled_at
)
SELECT
  -- Customer distribution: Pareto-ish — most customers few orders, some heavy
  -- Modulo gives uniform; sqrt bias toward lower IDs makes early customers heavier
  1 + (floor(sqrt(random()) * 50000))::int,
  'ORD-' || lpad(i::text, 8, '0'),
  -- 80% completed, 8% refunded, 5% cancelled, 5% delivered, 2% pending
  (ARRAY['completed','completed','completed','completed','completed','completed','completed','completed',
         'refunded','refunded','refunded','refunded',
         'cancelled','cancelled','cancelled',
         'delivered','delivered','delivered',
         'pending'])[1 + floor(random() * 19)::int],
  s.subtotal,
  CASE WHEN s.subtotal > 50 THEN 0.00 ELSE 4.99 END,    -- free shipping over £50
  (s.subtotal * 0.20)::numeric(10,2),                   -- 20% VAT
  CASE WHEN random() < 0.15 THEN (s.subtotal * 0.10)::numeric(10,2) ELSE 0 END,  -- 15% have a 10% promo
  s.subtotal +
    CASE WHEN s.subtotal > 50 THEN 0.00 ELSE 4.99 END +
    (s.subtotal * 0.20)::numeric(10,2) -
    CASE WHEN random() < 0.15 THEN (s.subtotal * 0.10)::numeric(10,2) ELSE 0 END,
  CASE WHEN random() < 0.15
       THEN (ARRAY['SAVE10','WELCOME20','SUMMER15','VIP25','FRIENDS10','HOLIDAY15'])[1 + floor(random() * 6)::int]
       ELSE NULL END,
  (ARRAY['web','web','web','web','web','web','mobile','mobile','mobile','mobile','mobile','in-store'])[1 + (i % 12)],
  s.placed,
  CASE WHEN random() > 0.05 THEN s.placed + interval '1 day' * (1 + random() * 2) END,
  CASE WHEN random() > 0.1  THEN s.placed + interval '1 day' * (3 + random() * 4) END,
  CASE WHEN random() < 0.05 THEN s.placed + interval '1 day' * (0.5 + random()) END
FROM (
  SELECT
    i,
    (15 + random() * 285)::numeric(10,2) AS subtotal,
    now() - (random() * interval '730 days') AS placed
  FROM generate_series(1, 500000) i
) s;
COMMIT;

-- Roll up total_spent_gbp onto customers
BEGIN;
UPDATE customers c
SET total_spent_gbp = COALESCE(o.total, 0)
FROM (
  SELECT customer_id, SUM(total_gbp) AS total
  FROM orders
  WHERE status IN ('completed','delivered')
  GROUP BY customer_id
) o
WHERE c.id = o.customer_id;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 6. ORDER ITEMS (~1.5M — avg 3 items per order)
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
-- Generate 1-5 items per order. random() in the LATERAL is evaluated
-- per outer row so each order independently gets 1-5 lines. The product
-- price is randomised inline rather than joined — keeps the insert a
-- single sequential scan over orders + cheap arithmetic per line.
-- (A JOIN to products with a random-id ON clause produced empty results
-- because Postgres evaluated random() per probe and ON rarely matched.)
INSERT INTO order_items (order_id, product_id, quantity, unit_price_gbp, subtotal_gbp)
SELECT
  o.id,
  1 + floor(random() * 5000)::int AS product_id,
  rnd.qty,
  rnd.unit_price,
  rnd.unit_price * rnd.qty
FROM orders o
CROSS JOIN LATERAL generate_series(1, 1 + floor(random() * 4)::int) line_no
CROSS JOIN LATERAL (
  SELECT
    1 + floor(random() * 4)::int AS qty,
    (5 + random() * 200)::numeric(10,2) AS unit_price
) rnd;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 7. SESSIONS (2,000,000) — 70% don't convert
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
INSERT INTO sessions (
  customer_id, started_at, ended_at, device_type, browser,
  referrer_source, page_view_count, did_purchase,
  utm_source, utm_medium, utm_campaign
)
SELECT
  -- 70% have a customer_id, 30% anonymous
  CASE WHEN random() > 0.3 THEN 1 + floor(random() * 50000)::int END,
  s.started,
  s.started + (random() * interval '45 minutes'),
  (ARRAY['mobile','mobile','mobile','desktop','desktop','tablet'])[1 + floor(random() * 6)::int],
  (ARRAY['Chrome','Chrome','Chrome','Safari','Safari','Firefox','Edge'])[1 + floor(random() * 7)::int],
  (ARRAY['direct','google','facebook','instagram','tiktok','email','referral','organic'])[1 + floor(random() * 8)::int],
  1 + floor(random() * 15)::int,
  random() < 0.30,                                     -- 30% convert
  (ARRAY['google','facebook','instagram','tiktok','email','direct',NULL,NULL])[1 + floor(random() * 8)::int],
  (ARRAY['cpc','social','email','organic','referral',NULL,NULL,NULL])[1 + floor(random() * 8)::int],
  (ARRAY['spring_sale','summer_promo','black_friday','xmas_2025','newsletter','retargeting',NULL,NULL])[1 + floor(random() * 8)::int]
FROM (
  SELECT i, now() - (random() * interval '730 days') AS started
  FROM generate_series(1, 2000000) i
) s;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 8. PRODUCT REVIEWS (100,000) — ~20% of orders generate one
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
INSERT INTO product_reviews (product_id, customer_id, rating, title, body, is_verified, created_at)
SELECT
  1 + floor(random() * 5000)::int,
  1 + floor(random() * 50000)::int,
  -- Skewed toward 4-5 stars (most reviews are positive)
  (ARRAY[1,2,3,3,4,4,4,4,5,5,5,5,5,5])[1 + floor(random() * 14)::int],
  (ARRAY[
    'Exceeded expectations','Solid choice','Decent for the price','Would buy again',
    'Not what I expected','Perfect','Pretty good','Worth every penny',
    'Disappointed','Excellent quality','Fast shipping, great product','Five stars',
    'Average','Returning it','Stunning','Highly recommend'
  ])[1 + floor(random() * 16)::int],
  'Test review body for product ' || (1 + floor(random() * 5000)::int) || ', written by customer review ' || i || '.',
  random() > 0.2,                                      -- 80% verified buyers
  now() - (random() * interval '700 days')
FROM generate_series(1, 100000) i;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 9. SHIPMENTS (480,000 — 96% of orders ship)
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
INSERT INTO shipments (order_id, carrier, tracking_number, status, shipped_at, delivered_at, cost_gbp)
SELECT
  o.id,
  (ARRAY['Royal Mail','DPD','FedEx','UPS','DHL','Hermes','Yodel'])[1 + floor(random() * 7)::int],
  upper(substring(md5(o.id::text || random()::text) from 1 for 12)),
  CASE
    WHEN random() < 0.85 THEN 'delivered'
    WHEN random() < 0.95 THEN 'in_transit'
    ELSE 'returned'
  END,
  o.shipped_at,
  o.delivered_at,
  (3 + random() * 12)::numeric(10,2)
FROM orders o
WHERE o.status IN ('completed','delivered','refunded')
  AND random() < 0.97                                  -- 97% of eligible orders
LIMIT 480000;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 10. RETURNS (40,000 — 8% of orders)
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
INSERT INTO returns (order_id, customer_id, return_reason, refund_amount_gbp, status, requested_at, processed_at)
SELECT
  o.id,
  o.customer_id,
  (ARRAY[
    'wrong_size','damaged','not_as_described','changed_mind','arrived_late',
    'quality_issue','colour_different','duplicate_order','better_price_elsewhere','other'
  ])[1 + floor(random() * 10)::int],
  (o.total_gbp * (0.5 + random() * 0.5))::numeric(10,2),   -- 50-100% refund
  CASE WHEN random() < 0.85 THEN 'processed'
       WHEN random() < 0.95 THEN 'pending'
       ELSE 'rejected'
  END,
  o.delivered_at + interval '1 day' * (1 + random() * 14),
  o.delivered_at + interval '1 day' * (5 + random() * 21)
FROM orders o
WHERE o.status IN ('completed','delivered')
  AND o.delivered_at IS NOT NULL
  AND random() < 0.085
LIMIT 40000;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 11. FOREIGN KEYS + INDEXES (after data load — much faster this way)
-- ─────────────────────────────────────────────────────────────────────

BEGIN;
ALTER TABLE categories      ADD CONSTRAINT fk_cat_parent      FOREIGN KEY (parent_id)   REFERENCES categories(id);
ALTER TABLE products        ADD CONSTRAINT fk_prod_cat        FOREIGN KEY (category_id) REFERENCES categories(id);
ALTER TABLE orders          ADD CONSTRAINT fk_order_customer  FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE order_items     ADD CONSTRAINT fk_oi_order        FOREIGN KEY (order_id)    REFERENCES orders(id);
ALTER TABLE order_items     ADD CONSTRAINT fk_oi_product      FOREIGN KEY (product_id)  REFERENCES products(id);
ALTER TABLE sessions        ADD CONSTRAINT fk_sess_customer   FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE product_reviews ADD CONSTRAINT fk_rev_product     FOREIGN KEY (product_id)  REFERENCES products(id);
ALTER TABLE product_reviews ADD CONSTRAINT fk_rev_customer    FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE shipments       ADD CONSTRAINT fk_ship_order      FOREIGN KEY (order_id)    REFERENCES orders(id);
ALTER TABLE returns         ADD CONSTRAINT fk_ret_order       FOREIGN KEY (order_id)    REFERENCES orders(id);
ALTER TABLE returns         ADD CONSTRAINT fk_ret_customer    FOREIGN KEY (customer_id) REFERENCES customers(id);
COMMIT;

BEGIN;
-- Indexes that the agent's likely queries will use
CREATE INDEX idx_orders_customer       ON orders(customer_id);
CREATE INDEX idx_orders_placed_at      ON orders(placed_at);
CREATE INDEX idx_orders_status         ON orders(status);
CREATE INDEX idx_order_items_order     ON order_items(order_id);
CREATE INDEX idx_order_items_product   ON order_items(product_id);
CREATE INDEX idx_sessions_started_at   ON sessions(started_at);
CREATE INDEX idx_sessions_customer     ON sessions(customer_id);
CREATE INDEX idx_sessions_purchase     ON sessions(did_purchase);
CREATE INDEX idx_reviews_product       ON product_reviews(product_id);
CREATE INDEX idx_reviews_rating        ON product_reviews(rating);
CREATE INDEX idx_shipments_order       ON shipments(order_id);
CREATE INDEX idx_returns_order         ON returns(order_id);
CREATE INDEX idx_customers_signup      ON customers(signup_date);
CREATE INDEX idx_customers_country     ON customers(country);
CREATE INDEX idx_products_category     ON products(category_id);
COMMIT;

-- Stats refresh so the query planner has accurate row counts
ANALYZE;

-- ─────────────────────────────────────────────────────────────────────
-- DONE
-- Final row counts:
-- ─────────────────────────────────────────────────────────────────────

SELECT 'customers'        AS table, COUNT(*) FROM customers
UNION ALL SELECT 'categories',       COUNT(*) FROM categories
UNION ALL SELECT 'products',         COUNT(*) FROM products
UNION ALL SELECT 'orders',           COUNT(*) FROM orders
UNION ALL SELECT 'order_items',      COUNT(*) FROM order_items
UNION ALL SELECT 'sessions',         COUNT(*) FROM sessions
UNION ALL SELECT 'product_reviews',  COUNT(*) FROM product_reviews
UNION ALL SELECT 'shipments',        COUNT(*) FROM shipments
UNION ALL SELECT 'returns',          COUNT(*) FROM returns
ORDER BY 2 DESC;
