-- Studio Velox — Lead CRM verification migration
-- Run ONCE against velox_leads. SQLite has no "ADD COLUMN IF NOT EXISTS",
-- so re-running this will error on the first column. That is expected.
--
--   npx wrangler d1 execute velox_leads --remote --file=./migrations/001_lead_verification.sql
--
-- Test locally first by swapping --remote for --local.

-- ---------------------------------------------------------------
-- 1. Contact fields
-- ---------------------------------------------------------------
ALTER TABLE leads ADD COLUMN email TEXT;
ALTER TABLE leads ADD COLUMN contact_name TEXT;

-- ---------------------------------------------------------------
-- 2. Verification fields
-- ---------------------------------------------------------------
-- website_status is what we actually KNOW, not what we guessed:
--   unchecked   — Google listed no website and we have not looked yet
--   none        — checked, no domain found anywhere
--   parked      — domain owned, holding / "coming soon" page (best lead)
--   expired     — domain lapsed or now belongs to someone else (best opener)
--   social_only — Facebook / Instagram / Linktree only
--   live        — real working website
ALTER TABLE leads ADD COLUMN website_status TEXT DEFAULT 'unchecked';
ALTER TABLE leads ADD COLUMN real_website TEXT;
ALTER TABLE leads ADD COLUMN verify_note TEXT;
ALTER TABLE leads ADD COLUMN verified_at TEXT;

-- ---------------------------------------------------------------
-- 3. Quality signals pulled from Google Places
-- ---------------------------------------------------------------
ALTER TABLE leads ADD COLUMN rating REAL;
ALTER TABLE leads ADD COLUMN review_count INTEGER;
ALTER TABLE leads ADD COLUMN business_status TEXT;

-- ---------------------------------------------------------------
-- 4. Scoring
-- ---------------------------------------------------------------
-- lead_score is 0-100, computed. tier is the label shown in the UI:
--   prime | strong | maybe | skip | unrated
-- score_locked = 1 means Phil set the tier by hand; never auto-overwrite it.
ALTER TABLE leads ADD COLUMN lead_score INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN tier TEXT DEFAULT 'unrated';
ALTER TABLE leads ADD COLUMN score_locked INTEGER DEFAULT 0;

-- ---------------------------------------------------------------
-- 5. Backfill from the old hot/warm/cool data
-- ---------------------------------------------------------------
-- Old "hot" was really "Google listed no website" — which today proved
-- is not the same as "has no website". Everything hot becomes unchecked.
UPDATE leads
   SET website_status = 'unchecked'
 WHERE (website IS NULL OR website = '')
   AND (website_status IS NULL OR website_status = 'unchecked');

UPDATE leads
   SET website_status = 'social_only'
 WHERE website IS NOT NULL
   AND website != ''
   AND (
        lower(website) LIKE '%facebook.com%'
     OR lower(website) LIKE '%instagram.com%'
     OR lower(website) LIKE '%linktr.ee%'
     OR lower(website) LIKE '%linktree%'
     OR lower(website) LIKE '%tiktok.com%'
   );

-- A website Google gave us that is not a social link still needs verifying
-- (it may be parked or dead), so it goes to 'unchecked' too, not 'live'.
UPDATE leads
   SET website_status = 'unchecked'
 WHERE website IS NOT NULL
   AND website != ''
   AND website_status = 'unchecked';

-- ---------------------------------------------------------------
-- 6. Indexes for the filter buttons
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_tier           ON leads (tier);
CREATE INDEX IF NOT EXISTS idx_leads_website_status ON leads (website_status);
CREATE INDEX IF NOT EXISTS idx_leads_status         ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_score          ON leads (lead_score DESC);
