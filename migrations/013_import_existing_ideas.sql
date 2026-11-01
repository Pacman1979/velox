/* ---------------------------------------------------------------------------
   013_import_existing_ideas.sql — bring the two live ideas boards across

   Each client site already had its OWN /api/ideas on its OWN domain, so the
   two boards were never sharing data — they were just unprotected, and
   nothing told Phil when something new arrived.

   Read straight from the live pages on 1 November 2026:
       boulangerievietnam.com.au/api/ideas   4 entries, Aug-Oct
       thebreaththerapy.com.au/api/ideas     2 entries, incl. one done

   Everything is preserved: author, exact timestamp, category where the board
   had one, and done state. notified_at is backdated so the digest does not
   email six old ideas as if they arrived this morning.

   Newlines are written as char(10) on purpose. The D1 console collapses real
   newlines on paste, which would otherwise mangle Taylor's class list.
   --------------------------------------------------------------------------- */

/* The Breath Therapy board had categories; this keeps them. */
ALTER TABLE client_ideas ADD COLUMN category TEXT;


/* ---- Boulangerie Vietnam Bakery (client_id 6) ---- */

INSERT INTO client_ideas (client_id, body, author, status, category, created_at, notified_at)
VALUES (6, 'Quick thought... special privileges for monthly subscription e.g. 5th coffee free?', 'Phil', 'seen', NULL, '2026-10-02 09:40:42', datetime('now'));

INSERT INTO client_ideas (client_id, body, author, status, category, created_at, notified_at)
VALUES (6, 'Maybe not a coffee only membership. But allow some other benefits. Basically Adrian Portelli used membership and CostCo. However, I’m unsure about what to include- reduced price for membership? Still have the coffee and perhaps promotions bi-monthly', 'Jeremy', 'seen', NULL, '2026-08-18 03:14:19', datetime('now'));

INSERT INTO client_ideas (client_id, body, author, status, category, created_at, notified_at)
VALUES (6, 'Google review links on site', 'Phil', 'seen', NULL, '2026-08-09 01:24:17', datetime('now'));

INSERT INTO client_ideas (client_id, body, author, status, category, created_at, notified_at)
VALUES (6, 'Laser doorbell alerting staff when a customer has arrived.', 'Phil', 'seen', NULL, '2026-08-06 12:08:27', datetime('now'));


/* ---- The Breath Therapy (client_id 5) ---- */

INSERT INTO client_ideas (client_id, body, author, status, category, created_at, notified_at)
VALUES (5, 'Hey Phil ' || char(10) || char(10) || 'So my upcoming classes are as follows. ' || char(10) || char(10) || 'September 20 - BREATHE at The Move Room 10am ' || char(10) || 'October 3rd - Rise & Flow - Pilates & Breathwork by the Beach 6am ' || char(10) || 'October 18 - BREATHE at The Move Room 10am ' || char(10) || 'November 15 - BREATHE at The Move Room 10am ' || char(10) || char(10) || 'Thank you so much. Appreciate your help as always!', 'Taylor', 'done', 'website', '2026-09-03 01:17:13', datetime('now'));

INSERT INTO client_ideas (client_id, body, author, status, category, created_at, notified_at)
VALUES (5, 'I''m wondering whether it''s worth adding a value for the one-on-one work you do to give people an idea e.g. "From $120"?', 'Phil', 'seen', 'services', '2026-09-07 04:54:03', datetime('now'));


/* Check: should be 6 rows, 4 for the bakery and 2 for the breath therapy. */
SELECT c.name, COUNT(*) AS ideas
  FROM client_ideas i JOIN care_clients c ON c.id = i.client_id
 GROUP BY c.name;
