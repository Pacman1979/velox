-- ===========================================================================
-- SAVE THIS FILE AT:  ~/VELOX/migrations/007_more_categories.sql
-- New file. Run it ONCE in the D1 console, then commit it so the folder is a
-- complete history. It is NOT safe to run twice — the ALTER TABLE will fail
-- the second time, which is harmless but will stop the rest of the script.
-- ===========================================================================
--
-- 69 new categories, and a priority column so the queue works through the
-- best ones first.
--
-- ---------------------------------------------------------------------------
-- Why this reverses what 002 said
-- ---------------------------------------------------------------------------
-- Migration 002 said: "Deliberately no dentists, lawyers or real estate —
-- they almost all have sites already and they are not your client."
--
-- That was about whether they HAVE a website. The better question is whether
-- a website decides anything for them. A cafe is a visual, drop-in-on-a-whim
-- business and Instagram does the craving job better than any website could.
-- A conveyancer is the opposite: nobody picks one off a pretty feed. They
-- need to be reassured before they ring, and that happens on a website or it
-- does not happen.
--
-- So the categories below are the ones where that logic flips.
--
-- ---------------------------------------------------------------------------
-- The catch, stated plainly
-- ---------------------------------------------------------------------------
-- 002's objection was not wrong, it was just answering a different question.
-- Most lawyers and dentists DO have a website. The verifier will mark them
-- 'live' and /today filters 'live' out, so a lot of these searches will fill
-- the database with rows you never see.
--
-- The opportunity in these categories is not an absent website. It is a bad
-- one — a 2014 site with no phone viewport that the owner is quietly
-- embarrassed by, at a budget a cafe does not have. The verifier cannot
-- currently tell a good site from an ugly one, so that is the next piece of
-- work, and until it exists these categories will look quieter than they are.
--
-- ---------------------------------------------------------------------------
-- The arithmetic, also stated plainly
-- ---------------------------------------------------------------------------
-- 83 categories x 18 suburbs = 1,494 combinations.
--
--   5 searches a week  (today)   = 299 weeks. Not a plan.
--  12 searches a week            = 124 weeks. Still not a plan.
--  12 a day                      =  18 weeks for everything.
--  12 a day, priority 1 only     =   5 weeks for the 432 best combinations.
--
-- Which is why the priority column exists, and why the weekly cron should
-- become daily before this list is worth having.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The priority column
-- ---------------------------------------------------------------------------
-- 1 = search these first. 4 = search these when the rest is done.
-- SQLite has no ADD COLUMN IF NOT EXISTS, so this line is the reason the
-- script must only be run once.

ALTER TABLE search_queue ADD COLUMN priority INTEGER DEFAULT 2;

CREATE INDEX IF NOT EXISTS idx_queue_priority
  ON search_queue (active, priority ASC, last_run ASC);

-- ---------------------------------------------------------------------------
-- 2. Re-rank what is already in there
-- ---------------------------------------------------------------------------
-- This encodes what you have learned on the footpath, not a rule from
-- anywhere. Change any of it with a single UPDATE.

-- Trades you already had. These stay at the front.
UPDATE search_queue SET priority = 1
 WHERE category IN ('mechanic', 'landscaper');

-- Appointment businesses. Still worth doing, not worth doing first.
UPDATE search_queue SET priority = 3
 WHERE category IN ('barber', 'hair salon', 'nail salon', 'massage therapist',
                    'pet grooming', 'florist', 'pilates studio');

-- Food. Your own conclusion: Instagram already does this job for them.
UPDATE search_queue SET priority = 4
 WHERE category IN ('cafe', 'bakery', 'fish and chips', 'greengrocer', 'butcher');

-- ---------------------------------------------------------------------------
-- 3. The new categories
-- ---------------------------------------------------------------------------
-- Every one is phrased as something Google Places will actually return
-- results for. Nine of your list are properties of a business rather than
-- searchable categories ("multi-location medical clinics", "trade companies
-- covering multiple regions", "print-on-demand merch sellers") so they are
-- not here; see the note at the bottom.

WITH categories(name, ord, pri) AS (
  VALUES
    -- PRIORITY 1 — trades and the "I need someone now" searches.
    -- Highest chance of no website or a bad one, and they answer their phone.
    ('plumber',                 1, 1),
    ('emergency plumber',       2, 1),
    ('electrician',             3, 1),
    ('builder',                 4, 1),
    ('carpenter',               5, 1),
    ('painter',                 6, 1),
    ('roofer',                  7, 1),
    ('air conditioning installer', 8, 1),
    ('pool builder',            9, 1),
    ('pool maintenance',       10, 1),
    ('pest control',           11, 1),
    ('locksmith',              12, 1),
    ('mobile mechanic',        13, 1),
    ('towing service',         14, 1),
    ('carpet cleaning',        15, 1),
    ('gutter cleaning',        16, 1),
    ('appliance repair',       17, 1),
    ('removalist',             18, 1),
    ('skip bin hire',          19, 1),
    ('pressure washing',       20, 1),
    ('handyman',               21, 1),
    ('lawn mowing',            22, 1),

    -- PRIORITY 2 — trust and credibility. Nobody picks these off a feed.
    ('family lawyer',          23, 2),
    ('conveyancer',            24, 2),
    ('accountant',             25, 2),
    ('bookkeeper',             26, 2),
    ('financial planner',      27, 2),
    ('mortgage broker',        28, 2),
    ('insurance broker',       29, 2),
    ('dentist',                30, 2),
    ('medical centre',         31, 2),
    ('physiotherapist',        32, 2),
    ('psychologist',           33, 2),
    ('chiropractor',           34, 2),
    ('podiatrist',             35, 2),
    ('veterinary clinic',      36, 2),
    ('hearing clinic',         37, 2),
    ('driving instructor',     38, 2),
    ('photographer',           39, 2),
    ('tutoring centre',        40, 2),

    -- PRIORITY 3 — comparison purchases, bookings, and shops.
    ('real estate agency',     41, 3),
    ('commercial leasing agent', 42, 3),
    ('car dealership',         43, 3),
    ('furniture store',        44, 3),
    ('jeweller',               45, 3),
    ('wedding venue',          46, 3),
    ('solar installer',        47, 3),
    ('beauty salon',           48, 3),
    ('day spa',                49, 3),
    ('yoga studio',            50, 3),
    ('tattoo studio',          51, 3),
    ('boutique clothing store', 52, 3),
    ('surf shop',              53, 3),
    ('health food store',      54, 3),
    ('bike shop',              55, 3),
    ('pet supplies store',     56, 3),
    ('funeral home',           57, 3),
    ('aged care provider',     58, 3),
    ('retirement village',     59, 3),
    ('rsl club',               60, 3),

    -- PRIORITY 4 — business-to-business. Real budgets, slowest to warm up,
    -- and almost no Google reviews because their customers never leave any.
    ('commercial cleaning',    61, 4),
    ('it support',             62, 4),
    ('printing company',       63, 4),
    ('signage company',        64, 4),
    ('freight company',        65, 4),
    ('office supplies',        66, 4),
    ('industrial supplies',    67, 4),
    ('recruitment agency',     68, 4),
    ('childcare centre',       69, 4)
),
suburbs(name, ord) AS (
  VALUES
    ('Burleigh Heads',    1), ('Burleigh Waters',  2), ('Palm Beach',      3),
    ('Miami',             4), ('Mermaid Beach',    5), ('Mermaid Waters',  6),
    ('Nobby Beach',       7), ('Currumbin',        8), ('Currumbin Waters', 9),
    ('Elanora',          10), ('Tugun',           11), ('Tallebudgera',   12),
    ('Varsity Lakes',    13), ('Reedy Creek',     14), ('Robina',         15),
    ('Mudgeeraba',       16), ('Bonogin',         17), ('Worongary',      18)
)
INSERT OR IGNORE INTO search_queue (category, suburb, priority)
SELECT c.name, s.name, c.pri
  FROM categories c
  CROSS JOIN suburbs s
 ORDER BY c.pri, s.ord, c.ord;

-- ---------------------------------------------------------------------------
-- Check it landed
-- ---------------------------------------------------------------------------
-- Expect: 1 -> 432, 2 -> 324, 3 -> 486, 4 -> 252. Total 1,494.
--
--   SELECT priority, COUNT(*) AS combos, COUNT(DISTINCT category) AS categories
--     FROM search_queue GROUP BY priority ORDER BY priority;
--
-- And to see what is next out of the gate:
--
--   SELECT priority, category, suburb FROM search_queue
--    WHERE active = 1 ORDER BY priority, (last_run IS NOT NULL), last_run
--    LIMIT 20;

-- ---------------------------------------------------------------------------
-- What was left out, and why
-- ---------------------------------------------------------------------------
-- Already in the queue, so not duplicated:
--   hair salons, nail salons, massage therapists, landscapers, pilates studios
--
-- Folded into a term Google will match:
--   "local accountants with older clientele"      -> accountant
--   "multi-branch real estate agencies"           -> real estate agency
--   "multi-site physio practices"                 -> physiotherapist
--   "multi-location medical clinics"              -> medical centre
--   "pest control franchises"                     -> pest control
--   "franchise cleaning companies"                -> commercial cleaning
--   "commercial electricians"                     -> electrician
--   "renovation/building companies"               -> builder
--   "emergency plumbers"                          -> kept separate, people
--                                                    search those words
--   "window/pressure cleaning"                    -> pressure washing
--   "mobile dog grooming"                         -> pet grooming (in queue)
--   "fine-dining restaurants"                     -> left out; food is now
--                                                    priority 4 on your own
--                                                    reasoning
--
-- Not a searchable category, or not a business that buys a website:
--   "construction subcontractors"       — too vague for a text search
--   "trade companies covering multiple suburbs"  — a property, not a category
--   "local artists selling prints"      — no shopfront to find
--   "specialty food producers"          — ditto, and usually a market stall
--   "print-on-demand merch sellers"     — not a local search at all
--   "handmade jewellery makers"         — use 'jeweller' and read the results
--   "candle/home fragrance makers"      — same
--   "church/community groups"           — rarely a paying client
--   "local gym chains"                  — 'gym' left out deliberately; the
--                                         big ones are franchised and the
--                                         small ones have Instagram
--
-- Group 9 of your list is the odd one out: "multi-location or service-area
-- businesses" is a thing a business IS, not a thing you can search for. The
-- way to find those is to notice, when a result comes back, that the same
-- name appears in three suburbs — which the dedupe already shows you.
