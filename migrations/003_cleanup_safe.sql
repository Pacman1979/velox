-- ===========================================================================
-- SAVE THIS FILE AT:  ~/VELOX/migrations/003_cleanup_safe.sql
-- ALREADY RUN against the live database. This file is the record of what
-- was done, kept for history. Do not run it again.
-- ===========================================================================

-- Studio Velox — database cleanup, part 1 of 2 (SAFE)
--
-- Nothing is dropped here. Every statement either tidies data in place or
-- copies from an old column into its replacement. Your Python script keeps
-- working throughout.
--
-- Run these ONE BLOCK AT A TIME in the D1 console. The console wraps a paste
-- in a single transaction, so one error rolls back everything in that paste.

-- ===========================================================================
-- BLOCK 1 — Normalise suburbs
-- ===========================================================================
-- "Burleigh Heads, QLD" and "Burleigh Heads" are two different suburbs as far
-- as the database is concerned. That is what let Palm Springs Burleigh in
-- twice, and it will stop the cron's duplicate check working, because
-- search_queue stores suburbs without the state.

UPDATE leads
   SET suburb = TRIM(
         REPLACE(REPLACE(REPLACE(suburb, ', QLD', ''), ',QLD', ''), ' QLD', '')
       )
 WHERE suburb IS NOT NULL;

-- Check before moving on:
--   SELECT DISTINCT suburb FROM leads ORDER BY suburb;


-- ===========================================================================
-- BLOCK 2 — Look at the duplicates BEFORE deleting anything
-- ===========================================================================
-- Run this on its own and read the output. Do not skip it.

SELECT lower(TRIM(name)) AS match_on,
       COUNT(*)          AS copies,
       GROUP_CONCAT(id)  AS ids,
       GROUP_CONCAT(suburb) AS suburbs
  FROM leads
 GROUP BY match_on
HAVING copies > 1
 ORDER BY copies DESC;


-- ===========================================================================
-- BLOCK 3 — Delete duplicates, keeping the lowest id
-- ===========================================================================
-- Only run this once BLOCK 2 output looks right to you. The lowest id is the
-- one you found first, so it is the one most likely to carry your notes.
--
-- Matches on name alone, not name + suburb, because the whole problem is that
-- the same shop was filed under two different suburbs.
--
-- NOTE: Tarte Bakery & Cafe and Tarte Beach House are NOT duplicates. They
-- are two venues owned by the same people, sharing one website. I got that
-- wrong earlier. This query leaves them alone because the names differ.

DELETE FROM leads
 WHERE id NOT IN (
   SELECT MIN(id) FROM leads GROUP BY lower(TRIM(name))
 );


-- ===========================================================================
-- BLOCK 4 — Merge the Python script's columns into this system's columns
-- ===========================================================================
-- Copies data across only where the destination is still empty, so nothing
-- this system has already worked out gets overwritten by older data.

-- reviews_total -> review_count
UPDATE leads
   SET review_count = reviews_total
 WHERE review_count IS NULL AND reviews_total IS NOT NULL;

-- owned_domain -> real_website (adding the scheme the Python script omits)
-- Skips anything this system has already verified. Hidden Perk is the reason:
-- the Python script recorded hiddenperk.com.au as their domain, and we since
-- proved that domain was never registered.
UPDATE leads
   SET real_website = CASE
         WHEN owned_domain LIKE 'http%' THEN owned_domain
         ELSE 'https://' || owned_domain
       END
 WHERE real_website IS NULL
   AND verify_note IS NULL
   AND owned_domain IS NOT NULL
   AND TRIM(owned_domain) != '';

-- web_status / domain_status -> website_status
-- Only fills rows this system has never verified (verify_note IS NULL), so a
-- real verification result always wins over the Python script's guess.
UPDATE leads
   SET website_status = CASE UPPER(COALESCE(web_status, domain_status))
         WHEN 'NO_URL'      THEN 'none'
         WHEN 'DEAD'        THEN 'none'
         WHEN 'PARKED'      THEN 'parked'
         WHEN 'SOCIAL_ONLY' THEN 'social_only'
         WHEN 'THIN'        THEN 'live'
         WHEN 'LIVE'        THEN 'live'
         ELSE website_status
       END
 WHERE verify_note IS NULL
   AND COALESCE(web_status, domain_status) IS NOT NULL;

-- trading -> business_status
UPDATE leads
   SET business_status = CASE UPPER(trading)
         WHEN 'OPEN'   THEN 'OPERATIONAL'
         WHEN 'CLOSED' THEN 'CLOSED_PERMANENTLY'
         ELSE business_status
       END
 WHERE business_status IS NULL AND trading IS NOT NULL;


-- ===========================================================================
-- BLOCK 5 — Confirm
-- ===========================================================================
SELECT COUNT(*) AS total_leads,
       SUM(CASE WHEN review_count   IS NULL THEN 1 ELSE 0 END) AS missing_reviews,
       SUM(CASE WHEN website_status IS NULL THEN 1 ELSE 0 END) AS missing_status,
       COUNT(DISTINCT suburb) AS distinct_suburbs
  FROM leads;
