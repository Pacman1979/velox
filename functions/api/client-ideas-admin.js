/**
 * /api/client-ideas-admin  —  Phil's side of the client suggestion boxes
 * ---------------------------------------------------------------------------
 * The client-facing endpoint is /api/client-ideas. This is the other half:
 * every client's ideas in one list, and the ability to answer one.
 *
 * It is NOT in the middleware's PUBLIC set, so it is locked by default and
 * needs X-Velox-Pin like every other private endpoint. That is the whole
 * access story — there is no second mechanism here to get wrong.
 *
 * Why a separate file rather than a mode on /api/client-ideas: that endpoint
 * is reachable from client websites and authenticates with a key that lives
 * in their page source. Putting "write a reply as Phil" behind the same door
 * would mean one bug away from a client answering their own ideas in your
 * voice. Different powers, different doors.
 *
 *   GET                       every idea, newest first, with client names
 *   POST { id, reply?, status? }   answer one, or move its status
 *
 * A reply is visible to the client the moment it is saved — their page shows
 * it under "Phil replied". There is no draft state, so write it as if they
 * are reading it, because they are.
 */

const MAX_REPLY = 2000;
const PAGE_SIZE = 300;
const STATUSES = ['new', 'seen', 'doing', 'done', 'no'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ env }) {
  if (!env.VELOX_DB) return json({ ok: false, error: 'No database binding' }, 500);

  const { results } = await env.VELOX_DB.prepare(
    `SELECT i.id, i.client_id, i.body, i.author, i.status, i.category,
            i.reply, i.replied_at, i.created_at, i.notified_at,
            c.name AS client, c.site_url
       FROM client_ideas i
       JOIN care_clients c ON c.id = i.client_id
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ?`
  ).bind(PAGE_SIZE).all();

  /* Which boards exist and whether each has a PIN yet.
     A board with no PIN is open to whoever opens it first, so this is the
     list to chase — not a nice-to-have. Never returns the PIN itself. */
  const { results: boards } = await env.VELOX_DB.prepare(
    `SELECT c.id, c.name, c.site_url, c.tier,
            CASE WHEN c.ideas_pin IS NULL OR c.ideas_pin = '' THEN 0 ELSE 1 END AS has_pin,
            (SELECT COUNT(*) FROM client_ideas i WHERE i.client_id = c.id) AS ideas
       FROM care_clients c
      WHERE c.active = 1 AND c.ideas_key IS NOT NULL
      ORDER BY has_pin ASC, c.name ASC`
  ).all();

  return json({ ok: true, ideas: results || [], boards: boards || [], statuses: STATUSES });
}

export async function onRequestPost({ request, env }) {
  if (!env.VELOX_DB) return json({ ok: false, error: 'No database binding' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request' }, 400);
  }

  /* Clear a client's PIN so they can set a new one themselves. Used when
     someone forgets theirs, or when a board's PIN was set by the wrong
     person. Phil never learns a PIN — he can only clear one. */
  if (body.action === 'resetpin') {
    const cid = Number(body.client_id);
    if (!cid) return json({ ok: false, error: 'Which client?' }, 400);
    const r = await env.VELOX_DB.prepare(
      'UPDATE care_clients SET ideas_pin = NULL WHERE id = ?'
    ).bind(cid).run();
    if (!r.meta || r.meta.changes === 0) {
      return json({ ok: false, error: 'No client with that id' }, 404);
    }
    return json({ ok: true, reset: true, client_id: cid });
  }

  const id = Number(body.id);
  if (!id) return json({ ok: false, error: 'Which idea?' }, 400);

  /* Three separate intentions, and they must not be confused:
       reply === undefined   leave the reply alone
       reply === ''          clear it
       reply === 'text'      set it
     Treating '' as "no change" would make a reply impossible to withdraw. */
  const sets = [];
  const binds = [];

  if (body.reply !== undefined) {
    const reply = String(body.reply).trim().slice(0, MAX_REPLY);
    sets.push('reply = ?');
    binds.push(reply || null);
    /* replied_at is what the monthly report counts as "finished this month",
       so it tracks the reply and is cleared with it. */
    sets.push(reply ? "replied_at = datetime('now')" : 'replied_at = NULL');
  }

  if (body.status !== undefined) {
    const status = String(body.status);
    if (STATUSES.indexOf(status) === -1) {
      return json({ ok: false, error: `Status must be one of: ${STATUSES.join(', ')}` }, 400);
    }
    sets.push('status = ?');
    binds.push(status);
  }

  if (!sets.length) return json({ ok: false, error: 'Nothing to change' }, 400);

  binds.push(id);
  await env.VELOX_DB.prepare(
    `UPDATE client_ideas SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();

  const row = await env.VELOX_DB.prepare(
    `SELECT i.id, i.client_id, i.body, i.author, i.status, i.category,
            i.reply, i.replied_at, i.created_at,
            c.name AS client, c.site_url
       FROM client_ideas i
       JOIN care_clients c ON c.id = i.client_id
      WHERE i.id = ?`
  ).bind(id).first();

  if (!row) return json({ ok: false, error: 'No idea with that id' }, 404);
  return json({ ok: true, idea: row });
}

export function onRequestOptions() {
  return new Response(null, { status: 204 });
}
