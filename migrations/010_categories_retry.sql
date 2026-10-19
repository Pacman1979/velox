/* ===========================================================================
 * 010_categories_retry.sql
 * ---------------------------------------------------------------------------
 * Finishes what 007 started, and fixes why it stopped.
 *
 * 007 got as far as adding the `priority` column and re-ranking the original
 * 14 categories — those worked, and the counts prove it: 36 + 126 + 90 = 252,
 * which is exactly 14 categories across 18 suburbs. Then it died on the big
 * INSERT with "incomplete input: SQLITE_ERROR", so the 69 new categories were
 * never queued.
 *
 * The cause is the same one that broke 008: the D1 dashboard console collapses
 * newlines when you paste, and a -- comment then swallows the rest of the
 * statement. 007 has 133 of them. This file has none; block comments only.
 *
 * Safe to run twice: INSERT OR IGNORE, and the UPDATE is idempotent.
 * Adds 69 x 18 = 1,242 rows, taking the queue to 1,494.
 * ======================================================================== */

/* --- cafes move down ------------------------------------------------------
 * Phil's call, and the right one: a cafe is a drop-in, walk-past business.
 * People already know where theirs is, or they find it on Instagram. Nobody
 * Googles "cafe" and then reads a website before deciding. Priority 5 puts
 * them behind everything else without deleting them.
 *
 * The other food shops stay at 4. A butcher, a greengrocer or a bakery sells
 * something people do search for by name, and they have stock, hours and
 * specials worth a page.
 */
UPDATE search_queue SET priority = 5 WHERE category = 'cafe';

/* --- the 69 categories that never made it in ---------------------------- */
WITH categories(name, ord, pri) AS (
  VALUES
    /* PRIORITY 1 - trades, and the "I need someone now" searches.
       Highest chance of no website or a bad one, and they answer the phone. */
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

    /* PRIORITY 2 - trust and credibility. Nobody picks these off a feed. */
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

    /* PRIORITY 3 - comparison purchases, bookings, and shops. */
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

    /* PRIORITY 4 - business to business. Real budgets, slowest to warm up,
       and almost no Google reviews because their customers never leave any. */
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
