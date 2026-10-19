/* ===========================================================================
 * 008_chat_leads.sql  —  inbound enquiries from the site assistant
 * ---------------------------------------------------------------------------
 * Safe to run more than once: every statement is IF NOT EXISTS.
 *
 * Why a separate table rather than rows in `leads`:
 *   `leads` holds businesses WE found — scored, verified, placed on a map,
 *   routed by /today. Every one has a place_id, a category and coordinates.
 *   These have none of that. They are people who came to us. Mixing them in
 *   would quietly break the scoring and put unmappable rows in the day's round.
 *
 * When one of these turns into a real prospect, copy it across by hand. That
 * is a good moment to make a decision, not one to automate.
 *
 * NOTE ON COMMENTS: block comments only, never the -- kind. The D1 dashboard
 * console collapses newlines when you paste, and a -- comment then swallows
 * the whole rest of the statement ("incomplete input: SQLITE_ERROR").
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS chat_leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  contact     TEXT    NOT NULL,   /* phone or email, whichever they gave   */
  site_url    TEXT,               /* their current site, if the audit ran  */
  interest    TEXT,               /* what they were asking about           */
  page        TEXT,               /* page of ours they were reading        */
  transcript  TEXT,               /* the conversation, so context is kept  */
  suburb      TEXT,               /* from Cloudflare, approximate          */
  referrer    TEXT,
  status      TEXT    DEFAULT 'new',   /* new|contacted|quoted|won|dead    */
  notes       TEXT,
  created_at  TEXT    DEFAULT (datetime('now'))
);

/* The two ways this table ever gets read: newest first, and what is open. */
CREATE INDEX IF NOT EXISTS idx_chat_leads_created ON chat_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_leads_status  ON chat_leads (status, created_at DESC);
