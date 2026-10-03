-- Studio Velox — search queue for the weekly cron
--
--   npx wrangler d1 execute velox_leads --remote --file=./migrations/002_search_queue.sql
--
-- Run it with --file, not by pasting into the D1 console. This is several
-- statements long and the console rolls the whole paste back if one of them
-- errors. Safe to run twice: the INSERT is OR IGNORE and the UNIQUE index
-- holds the line.
--
-- You never write the combinations by hand. You edit the two lists below and
-- the CROSS JOIN builds every pairing for you.

CREATE TABLE IF NOT EXISTS search_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL,
  suburb      TEXT NOT NULL,
  active      INTEGER DEFAULT 1,     -- 0 = paused, skipped by the cron
  last_run    TEXT,                  -- ISO timestamp, NULL = never run
  run_count   INTEGER DEFAULT 0,
  results_seen INTEGER DEFAULT 0,    -- businesses Google returned, all time
  new_leads   INTEGER DEFAULT 0,     -- how many were actually new to you
  note        TEXT,
  UNIQUE (category, suburb)
);

-- The cron always takes the least recently run rows, so this index matters.
CREATE INDEX IF NOT EXISTS idx_queue_next
  ON search_queue (active, last_run ASC);

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------
-- Categories skew towards trades and shopfronts that often have no website.
-- Deliberately no dentists, lawyers or real estate — they almost all have sites
-- already and they are not your client.
--
-- Suburbs are southern Gold Coast first, because that is where you are and
-- because a tight radius is what makes the Monday driving route work.
--
-- 14 categories x 18 suburbs = 252 combinations.

WITH categories(name, ord) AS (
  VALUES
    ('cafe',               1),
    ('bakery',             2),
    ('barber',             3),
    ('hair salon',         4),
    ('mechanic',           5),
    ('butcher',            6),
    ('nail salon',         7),
    ('pet grooming',       8),
    ('massage therapist',  9),
    ('florist',           10),
    ('landscaper',        11),
    ('pilates studio',    12),
    ('greengrocer',       13),
    ('fish and chips',    14)
),
suburbs(name, ord) AS (
  VALUES
    ('Burleigh Heads',    1),
    ('Burleigh Waters',   2),
    ('Palm Beach',        3),
    ('Miami',             4),
    ('Mermaid Beach',     5),
    ('Mermaid Waters',    6),
    ('Nobby Beach',       7),
    ('Currumbin',         8),
    ('Currumbin Waters',  9),
    ('Elanora',          10),
    ('Tugun',            11),
    ('Tallebudgera',     12),
    ('Varsity Lakes',    13),
    ('Reedy Creek',      14),
    ('Robina',           15),
    ('Mudgeeraba',       16),
    ('Broadbeach',       17),
    ('Broadbeach Waters',18)
)
INSERT OR IGNORE INTO search_queue (category, suburb)
SELECT c.name, s.name
FROM suburbs s
CROSS JOIN categories c
-- SUBURB is the outer loop, and this is the whole point of the ORDER BY.
--
-- The other way round, the queue runs cafes in all eighteen suburbs before it
-- reaches a single bakery — at five searches a week that is four months of
-- cafes before the first tradie. Suburb-first means every run covers five
-- different TRADES in one suburb, a suburb is finished in under three runs,
-- and the leads that land together are the ones you can visit in one morning.
ORDER BY s.ord, c.ord;

-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
--   SELECT COUNT(*) FROM search_queue;                        -- expect 252
--
--   -- what runs next:
--   SELECT category, suburb FROM search_queue
--    WHERE active = 1 ORDER BY (last_run IS NOT NULL), last_run ASC LIMIT 5;
--
--   -- which categories are actually worth searching, after a few weeks:
--   SELECT category, SUM(new_leads) n, SUM(results_seen) seen
--     FROM search_queue GROUP BY category ORDER BY n DESC;
--
--   -- pause one that keeps coming back empty:
--   UPDATE search_queue SET active = 0 WHERE category = 'greengrocer';
