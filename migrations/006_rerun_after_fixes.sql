-- ===========================================================================
-- SAVE THIS FILE AT:  ~/VELOX/migrations/006_rerun_after_fixes.sql
-- RUN IT ONCE, after deploying the fixed scoring.js and verify.js.
--   npx wrangler d1 execute velox_leads --remote --file=./migrations/006_rerun_after_fixes.sql
-- ===========================================================================
--
-- Cleans up the three things the first live cron run got wrong. Nothing here
-- deletes a lead — franchises are kept so the cron does not rediscover them
-- every week, just pushed to the bottom where they belong.

-- ---------------------------------------------------------------------------
-- 1. Franchise outlets → skip, locked
-- ---------------------------------------------------------------------------
-- The outlet genuinely has no website; head office owns the web presence and
-- the franchisee cannot buy one from you. score_locked = 1 stops them climbing
-- back up the list every time anything rescores.

UPDATE leads
SET tier = 'skip',
    lead_score = 5,
    score_locked = 1,
    score_reason = 'Franchise outlet — head office controls the website. Not a free-build lead.'
WHERE score_locked IS NOT 1
  AND (
       lower(name) LIKE '%bakers delight%'
    OR lower(name) LIKE '%brumbys%'
    OR lower(name) LIKE '%cheesecake shop%'
    OR lower(name) LIKE '%michels patisserie%'
    OR lower(name) LIKE '%donut king%'
    OR lower(name) LIKE '%muffin break%'
    OR lower(name) LIKE '%gloria jean%'
    OR lower(name) LIKE '%coffee club%'
    OR lower(name) LIKE '%zarraffa%'
    OR lower(name) LIKE '%jamaica blue%'
    OR lower(name) LIKE '%just cuts%'
    OR lower(name) LIKE '%price attack%'
    OR lower(name) LIKE '%stefan hair%'
    OR lower(name) LIKE '%hairhouse%'
    OR lower(name) LIKE '%toni%guy%'
    OR lower(name) LIKE '%ultra tune%'
    OR lower(name) LIKE '%ultratune%'
    OR lower(name) LIKE '%auto masters%'
    OR lower(name) LIKE '%midas%'
    OR lower(name) LIKE '%bob jane%'
    OR lower(name) LIKE '%beaurepaires%'
    OR lower(name) LIKE '%jax tyres%'
    OR lower(name) LIKE '%mycar%'
    OR lower(name) LIKE '%tyrepower%'
    OR lower(name) LIKE '%lube mobile%'
    OR lower(name) LIKE '%jim''s %'
    OR lower(name) LIKE '%jims %'
    OR lower(name) LIKE '%hire a hubby%'
    OR lower(name) LIKE '%poolwerx%'
    OR lower(name) LIKE '%anytime fitness%'
    OR lower(name) LIKE '%snap fitness%'
    OR lower(name) LIKE '%battery world%'
  );

-- ---------------------------------------------------------------------------
-- 2. Re-check everything the old matcher called 'live' on a GUESSED domain
-- ---------------------------------------------------------------------------
-- These are the rows at risk from the palmbeach.com bug: the verifier claimed
-- a working site using only words the domain itself supplied. A wrong 'live'
-- is the expensive direction — it tells you to skip a lead that may have
-- nothing at all.
--
-- Setting website_status back to 'unchecked' puts them in the verifier's queue.
-- real_website is cleared so a wrong URL cannot be shown on the doorstep.

UPDATE leads
SET website_status = 'unchecked',
    real_website = NULL,
    verify_note = 'Re-checking: the old matcher could confirm a site using only the words the domain was built from.'
WHERE website_status = 'live'
  AND verify_note LIKE '%terms)%'
  AND score_locked IS NOT 1;

-- ---------------------------------------------------------------------------
-- 3. Re-check the accented names
-- ---------------------------------------------------------------------------
-- "Léa_hair" was slugged to "lahair" instead of "leahair", so its real domain
-- was never tested. Anything with a non-ASCII letter in the name is suspect.

UPDATE leads
SET website_status = 'unchecked',
    real_website = NULL,
    verify_note = 'Re-checking: accented letters in the name were dropped instead of folded.'
WHERE score_locked IS NOT 1
  AND name GLOB '*[^ -~]*';

-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
--   SELECT COUNT(*) FROM leads WHERE score_reason LIKE 'Franchise%';
--   SELECT COUNT(*) FROM leads WHERE website_status = 'unchecked';
--
-- Then run the verifier until it says "Nothing left to verify":
--   curl -s -X POST https://studiovelox.com/api/verify \
--     -H "X-Velox-Key: YOUR_KEY" -H 'Content-Type: application/json' \
--     -d '{"limit":10}'
