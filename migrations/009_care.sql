/* ===========================================================================
 * 009_care.sql  —  what the monthly care plans actually deliver
 * ---------------------------------------------------------------------------
 * Safe to run more than once: every statement is IF NOT EXISTS.
 *
 * Three things the pricing page promises, and the tables behind them:
 *   care_clients    who is on a plan, and which tier
 *   chat_questions  every question an assistant was asked   ($147 tier)
 *   health_reports  one row per client per month, so a re-run cannot
 *                   send anybody the same report twice
 *
 * NOTE ON COMMENTS: block comments only, never the -- kind. The D1 dashboard
 * console collapses newlines when you paste, and a -- comment then swallows
 * the whole rest of the statement ("incomplete input: SQLITE_ERROR").
 * ======================================================================== */

CREATE TABLE IF NOT EXISTS care_clients (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  site_url       TEXT    NOT NULL,           /* what gets audited          */
  contact_email  TEXT    NOT NULL,           /* where the report goes      */
  tier           INTEGER NOT NULL DEFAULT 1, /* 1=$47  2=$97  3=$147       */
  cf_site_tag    TEXT,                       /* Web Analytics site tag     */
  assistant_key  TEXT,                       /* matches chat_questions.site*/
  active         INTEGER NOT NULL DEFAULT 1,
  started_at     TEXT    DEFAULT (datetime('now')),
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS idx_care_active ON care_clients (active, tier);

/* Every question typed at an assistant, and whether it knew the answer.
   The ones it did not know are the ones worth reading.
   No IP, no session, no name: this is a question log, not a people log. */
CREATE TABLE IF NOT EXISTS chat_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site        TEXT    NOT NULL,
  question    TEXT    NOT NULL,
  topic       TEXT,                        /* answer it matched, or NULL   */
  answered    INTEGER NOT NULL DEFAULT 0,  /* 0 = it had to hand off       */
  page        TEXT,
  created_at  TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questions_site ON chat_questions (site, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_unanswered ON chat_questions (site, answered, created_at DESC);

/* One row per client per month. The UNIQUE constraint is the whole point:
   if the cron fires twice, or Phil runs it by hand to check what would go
   out, nobody receives the same report twice. */
CREATE TABLE IF NOT EXISTS health_reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      INTEGER NOT NULL,
  period         TEXT    NOT NULL,          /* 'YYYY-MM' reported on       */
  costing        INTEGER DEFAULT 0,
  watch          INTEGER DEFAULT 0,
  good           INTEGER DEFAULT 0,
  pageviews      INTEGER,
  questions      INTEGER,
  unanswered     INTEGER,
  sent           INTEGER NOT NULL DEFAULT 0,
  detail         TEXT,                      /* the report body, as sent    */
  created_at     TEXT    DEFAULT (datetime('now')),
  UNIQUE (client_id, period)
);

CREATE INDEX IF NOT EXISTS idx_reports_period ON health_reports (period, client_id);
