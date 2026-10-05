-- ===========================================================================
-- SAVE THIS FILE AT:  ~/VELOX/migrations/004_drop_old_columns.sql
-- ALREADY RUN against the live database. This file is the record of what
-- was done, kept for history. Do not run it again.
-- ===========================================================================

-- Studio Velox — database cleanup, part 2 of 2 (DESTRUCTIVE)
--
-- ###########################################################################
-- #  STOP. READ THIS FIRST.                                                 #
-- #                                                                         #
-- #  Your Python lead-gen script writes to five of the columns below:       #
-- #    web_status, reviews_total, owned_domain, domain_status, trading      #
-- #                                                                         #
-- #  The moment you drop them, that script will fail the next time it runs. #
-- #                                                                         #
-- #  So do NOT run this file until either:                                  #
-- #    (a) the Python script has been updated to write the new column       #
-- #        names, or                                                        #
-- #    (b) you have decided to retire that script entirely, because         #
-- #        verify.js and backfill.js now do the same job.                   #
-- #                                                                         #
-- #  Part 1 has already copied all the data across, so nothing is lost by   #
-- #  waiting. There is no deadline on this file.                            #
-- ###########################################################################
--
-- Before running, check nothing is indexed on these columns — SQLite refuses
-- to drop an indexed column:
--
--   SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='leads';
--
-- Run ONE LINE AT A TIME. If a line errors, that column is either already
-- gone or indexed; skip it and carry on with the next.

-- --- superseded by website_status -----------------------------------------
ALTER TABLE leads DROP COLUMN web_status;
ALTER TABLE leads DROP COLUMN domain_status;
ALTER TABLE leads DROP COLUMN has_website;

-- --- superseded by review_count -------------------------------------------
ALTER TABLE leads DROP COLUMN reviews_total;

-- --- superseded by real_website -------------------------------------------
ALTER TABLE leads DROP COLUMN owned_domain;

-- --- superseded by business_status ----------------------------------------
ALTER TABLE leads DROP COLUMN trading;

-- --- superseded by tier + lead_score --------------------------------------
ALTER TABLE leads DROP COLUMN score;


-- ===========================================================================
-- Deliberately KEPT
-- ===========================================================================
--   place_id     — you will need it for the driving route in section G
--   last_review  — review text feeds the site generation in section D
--   verified_at  — both systems write it, no conflict
--   social_post_url / social_embed_html / social_status — your own feature
--   score_reason — still written by scoring.js


-- ===========================================================================
-- Confirm
-- ===========================================================================
-- PRAGMA table_info(leads);
--
-- You should be down from 39 columns to 32, with no pair doing the same job.
