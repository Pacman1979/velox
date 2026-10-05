-- ===========================================================================
-- SAVE THIS FILE AT:  ~/VELOX/migrations/005_coordinates.sql
-- ALREADY RUN against the live database. This file is the record of what
-- was done, kept for history. Do not run it again.
-- ===========================================================================

-- Studio Velox — coordinates for the driving route
--
-- Run these ONE LINE AT A TIME in the D1 console.
-- "duplicate column name" just means it already exists — skip it and carry on.
--
-- Why now: Google's text search returns lat/lng and place_id in the SAME
-- response you already pay for. No extra API call, no extra cost. If the cron
-- runs for a month without storing them, every one of those leads needs a
-- second Places call later to plan a route. Capture them on the way in.

ALTER TABLE leads ADD COLUMN lat REAL;

ALTER TABLE leads ADD COLUMN lng REAL;

-- ---------------------------------------------------------------------------
-- Check
-- ---------------------------------------------------------------------------
-- PRAGMA table_info(leads);
--
-- You should now have 34 columns, with lat and lng at the end.
--
-- You already have a UNIQUE index on place_id (idx_leads_place_id). The cron
-- uses it to match a business exactly instead of guessing by name — which is
-- what let "Palm Springs Burleigh" in twice under two suburb spellings.
--
-- SQLite allows multiple NULLs in a unique index, so your existing rows with
-- no place_id will not collide with each other.
