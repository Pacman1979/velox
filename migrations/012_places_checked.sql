/* ---------------------------------------------------------------------------
   012_places_checked.sql — stop paying twice for the same lookup

   /api/place-website picked its candidates with:

       (website IS NULL OR website = '')
       AND website_status IN ('none', 'unchecked')

   A lead that Google HAS a website for leaves that set, because a website
   gets stored. A lead Google has nothing for does not: it keeps a NULL
   website and its 'none' status, so it matched again on the very next run.

   The evidence, from two real runs on 31 October:

       run 1   85 outstanding   40 calls   16 had a website
       run 2   69 outstanding   45 calls   14 had a website

   69 is 85 minus 16, not 85 minus 40. The 24 confirmed-nothing leads were
   looked up a second time, at full price, and returned exactly what they
   returned the first time. Paris Brest, George Gray Motors, Glossy Nails and
   21 others appear word for word in both runs' blank lists.

   This column records that Google has been ASKED, which is a different fact
   from what Google answered. Asking is what costs money, so that is the fact
   the query has to filter on.

   Write migrations with block comments only. The D1 dashboard console
   collapses newlines on paste, so a dash comment swallows the rest of the
   statement and you get "incomplete input: SQLITE_ERROR".
   --------------------------------------------------------------------------- */

ALTER TABLE leads ADD COLUMN places_checked_at TEXT;

/* Backfill the ones already paid for, so they are never asked about again.
   Both branches of the endpoint write a verify_note, and these two strings
   are the only ones it writes. */
UPDATE leads
   SET places_checked_at = datetime('now')
 WHERE places_checked_at IS NULL
   AND (verify_note = 'No website on their Google listing either — confirmed'
     OR verify_note = 'Website from Google, awaiting re-check');

CREATE INDEX IF NOT EXISTS idx_leads_places_checked
  ON leads (places_checked_at);
