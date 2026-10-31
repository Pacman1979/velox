/* ---------------------------------------------------------------------------
   011_client_ideas.sql — the client suggestion box

   A client with a care plan gets an /ideas page on their OWN site. It posts
   to studiovelox.com/api/client-ideas, so the database stays bound to the
   one Pages project Phil deploys. The client site never touches D1.

   Isolation is enforced here and in SQL, never in the page. Every read and
   write is scoped by client_id, which is resolved from a key the server
   looks up — a page cannot ask for someone else's rows because it has no
   way to name them.

   Two secrets per client, and they do different jobs:

     ideas_key  identifies WHICH client the page belongs to. It sits in the
                page source on their site, so treat it as public. On its own
                it grants nothing.

     ideas_pin  is what the client types once to get in. Short, theirs, and
                checked server-side with the same rate limiting as Phil's own
                PIN. Without it, anyone who found thebreaththerapy.com.au/ideas
                could read and post.

   Write migrations with block comments only. The D1 dashboard console
   collapses newlines on paste, so a dash comment swallows the rest of the
   statement and you get "incomplete input: SQLITE_ERROR".
   --------------------------------------------------------------------------- */

ALTER TABLE care_clients ADD COLUMN ideas_key TEXT;

ALTER TABLE care_clients ADD COLUMN ideas_pin TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_care_ideas_key
  ON care_clients (ideas_key)
  WHERE ideas_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS client_ideas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER NOT NULL,
  body        TEXT    NOT NULL,            /* what they asked for            */
  author      TEXT,                        /* who typed it, optional         */
  status      TEXT    NOT NULL DEFAULT 'new',
                                           /* new | seen | doing | done | no */
  reply       TEXT,                        /* Phil's answer, shown to them   */
  replied_at  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,                        /* set when it appears in a digest*/
  FOREIGN KEY (client_id) REFERENCES care_clients (id)
);

/* The digest asks one question every morning: what came in that I have not
   been told about? That is this index. */
CREATE INDEX IF NOT EXISTS idx_client_ideas_new
  ON client_ideas (notified_at, created_at);

/* The page asks one question: what are MY ideas, newest first. */
CREATE INDEX IF NOT EXISTS idx_client_ideas_client
  ON client_ideas (client_id, created_at DESC);
