/**
 * /api/client-ideas  —  a care client's suggestion box, hosted on their site
 * ---------------------------------------------------------------------------
 * The client's own site serves the page (thebreaththerapy.com.au/ideas).
 * The page talks to this endpoint. D1 stays bound to the one Pages project
 * Phil deploys, so a careless edit or a handover on a client site can never
 * reach the lead database.
 *
 * ---------------------------------------------------------------------------
 * Isolation — the whole point of the file
 * ---------------------------------------------------------------------------
 * A client sees their own ideas and Phil's replies to them. Nothing else.
 * That is enforced in one place: `client_id` is resolved from `ideas_key` by
 * a database lookup, and every statement below is scoped by it. The page
 * never sends a client_id and has no way to name another client's rows, so
 * there is no filter to forget and no parameter to tamper with.
 *
 * ---------------------------------------------------------------------------
 * The two secrets, and why there are two
 * ---------------------------------------------------------------------------
 *   ideas_key  — identifies the client. It is in the page source on their
 *                public website, so it IS public. On its own it grants
 *                nothing: every request needs the PIN as well.
 *   ideas_pin  — what the client types once. Rate limited per IP with the
 *                same guard as Phil's own PIN, and compared in constant time.
 *
 * Authentication fails closed. Rate limiting fails open: a KV outage must
 * lock nobody out of their own suggestion box.
 *
 * ---------------------------------------------------------------------------
 * CORS
 * ---------------------------------------------------------------------------
 * This is called cross-origin by design, from the client's domain. The
 * allowed origin is not a wildcard — it is the client's own `site_url`, read
 * from their row. A key that leaks therefore still cannot be used from
 * anywhere but the site it belongs to.
 */

import { pinLockout, pinFailed, pinPassed, sameSecret } from './_pinguard.js';

const MAX_BODY = 2000;      // one idea, not an essay
/* The Breath Therapy's board already used these five, so they carry over
   rather than being invented. An unknown value files as 'other' instead of
   being rejected: a dropdown the client cannot satisfy is worse than a
   default they can correct. */
const CATEGORIES = ['website', 'events', 'marketing', 'services', 'other'];
const MAX_AUTHOR = 60;
const MAX_PER_HOUR = 20;    // posts per IP
const PAGE_SIZE = 60;

function json(data, status = 200, origin = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Ideas-Key, X-Ideas-Pin';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The origin we will answer to for this client: their own site, nothing else. */
function originFor(row) {
  try { return new URL(row.site_url).origin; } catch { return null; }
}

/**
 * Resolve the client from the key, then check the PIN.
 * Returns { row, origin } on success, or a Response to return as-is.
 */
async function authenticate(request, env) {
  const key = request.headers.get('X-Ideas-Key') || '';
  const pin = request.headers.get('X-Ideas-Pin') || '';

  if (!key) return { fail: json({ ok: false, error: 'Not configured' }, 401) };

  const row = await env.VELOX_DB.prepare(
    `SELECT id, name, site_url, ideas_pin, active
       FROM care_clients
      WHERE ideas_key = ?`
  ).bind(key).first();

  /* An unknown key and a wrong PIN answer the same way, so the response
     never tells an attacker which half they got right. */
  if (!row || Number(row.active) !== 1) {
    return { fail: json({ ok: false, error: 'Not available' }, 401) };
  }

  const origin = originFor(row);

  /* pinLockout / pinFailed / pinPassed take (env, request) and bucket by IP,
     the same counter Phil's own PIN screens use. Shared per IP rather than
     per client, which is the right trade: a client hammering their own PIN
     locks only their own address, and Phil is never on it. */
  if (await pinLockout(env, request)) {
    return { fail: json({ ok: false, error: 'Too many attempts — wait an hour' }, 429, origin) };
  }

  if (!row.ideas_pin || !sameSecret(pin, row.ideas_pin)) {
    await pinFailed(env, request);
    return { fail: json({ ok: false, error: 'Wrong PIN' }, 401, origin) };
  }

  await pinPassed(env, request);
  return { row, origin };
}

/* ------------------------------------------------------------------ OPTIONS */
/* The preflight cannot carry headers, so it cannot be authenticated. It is
   answered for any origin but grants nothing — the real request still needs
   both secrets, and its response names one origin only. */
export function onRequestOptions({ request }) {
  const origin = request.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Ideas-Key, X-Ideas-Pin',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  });
}

/** The client row for a key, with no PIN involved. */
async function clientFor(env, key) {
  if (!key) return null;
  const row = await env.VELOX_DB.prepare(
    `SELECT id, name, site_url, ideas_pin, active
       FROM care_clients WHERE ideas_key = ?`
  ).bind(key).first();
  return (row && Number(row.active) === 1) ? row : null;
}

/* ---------------------------------------------------------------------- GET */
/* Their ideas and Phil's replies. Scoped by client_id, newest first. */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  /* A PIN-free probe so the page knows which screen to show: "choose a PIN"
     on a board that has never had one, or "enter your PIN" on one that has.
     It reveals only the business name — which is on the website it is served
     from — and whether a PIN exists. Never the PIN itself. */
  if (url.searchParams.get('probe') === '1') {
    const row = await clientFor(env, request.headers.get('X-Ideas-Key') || '');
    if (!row) return json({ ok: false, error: 'Not available' }, 401);
    return json({ ok: true, client: row.name, needsSetup: !row.ideas_pin },
      200, originFor(row));
  }

  const auth = await authenticate(request, env);
  if (auth.fail) return auth.fail;

  const { results } = await env.VELOX_DB.prepare(
    `SELECT id, body, author, status, category, reply, replied_at, created_at
       FROM client_ideas
      WHERE client_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ).bind(auth.row.id, PAGE_SIZE).all();

  return json({
    ok: true,
    client: auth.row.name,
    categories: CATEGORIES,
    ideas: results || [],
  }, 200, auth.origin);
}

/* --------------------------------------------------------------------- POST */
export async function onRequestPost({ request, env }) {
  /* Two PIN actions live before authentication, because one of them exists
     precisely for a board that cannot be authenticated yet. */
  let pre = null;
  try { pre = await request.clone().json(); } catch { /* handled below */ }

  if (pre && pre.action === 'setup') {
    /* A board with no PIN yet. The FIRST person to open it chooses one.
       Phil never sees it and never needs to.

       The honest caveat: between the page going live and the client setting
       a PIN, anyone with the URL could set it instead. That window is why
       /client-ideas shows which boards are still unset, and why the link
       should be sent to the client to use straight away. Once set, this
       branch is closed for good unless Phil resets it. */
    const row = await clientFor(env, request.headers.get('X-Ideas-Key') || '');
    if (!row) return json({ ok: false, error: 'Not available' }, 401);
    if (row.ideas_pin) {
      return json({ ok: false, error: 'This board already has a PIN' },
        409, originFor(row));
    }
    const fresh = String(pre.pin || '').trim();
    if (!/^\d{4,8}$/.test(fresh)) {
      return json({ ok: false, error: 'Choose 4 to 8 digits' }, 400, originFor(row));
    }
    await env.VELOX_DB.prepare(
      'UPDATE care_clients SET ideas_pin = ? WHERE id = ?'
    ).bind(fresh, row.id).run();
    return json({ ok: true, set: true }, 200, originFor(row));
  }

  if (pre && pre.action === 'changepin') {
    /* Needs the CURRENT pin, which authenticate() checks. */
    const auth0 = await authenticate(request, env);
    if (auth0.fail) return auth0.fail;
    const fresh = String(pre.pin || '').trim();
    if (!/^\d{4,8}$/.test(fresh)) {
      return json({ ok: false, error: 'Choose 4 to 8 digits' }, 400, auth0.origin);
    }
    await env.VELOX_DB.prepare(
      'UPDATE care_clients SET ideas_pin = ? WHERE id = ?'
    ).bind(fresh, auth0.row.id).run();
    return json({ ok: true, changed: true }, 200, auth0.origin);
  }

  const auth = await authenticate(request, env);
  if (auth.fail) return auth.fail;

  let incoming;
  try {
    incoming = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request' }, 400, auth.origin);
  }

  /* A real person never sees this field, let alone fills it in. */
  if (incoming.website) return json({ ok: true }, 200, auth.origin);

  const body = clean(incoming.body, MAX_BODY);
  const author = clean(incoming.author, MAX_AUTHOR);
  const raw = clean(incoming.category, 30).toLowerCase();
  const category = CATEGORIES.indexOf(raw) === -1 ? 'other' : raw;

  if (!body) {
    return json({ ok: false, error: 'Nothing to save' }, 400, auth.origin);
  }

  /* Rate limit on posting. Fails OPEN — a KV outage must not stop a client
     telling Phil something. */
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.IDEAS_KV) {
    try {
      const k = `clientideas:rate:${auth.row.id}:${ip}:${new Date().toISOString().slice(0, 13)}`;
      const seen = Number((await env.IDEAS_KV.get(k)) || 0);
      if (seen >= MAX_PER_HOUR) {
        return json({ ok: false, error: 'That is a lot of ideas at once — try again shortly' },
          429, auth.origin);
      }
      await env.IDEAS_KV.put(k, String(seen + 1), { expirationTtl: 7200 });
    } catch (err) {
      console.error('client-ideas rate limit failed:', err.message);
    }
  }

  await env.VELOX_DB.prepare(
    `INSERT INTO client_ideas (client_id, body, author, category)
     VALUES (?, ?, ?, ?)`
  ).bind(auth.row.id, body, author || null, category).run();

  /* Hand back the current list so the page never has to guess what it
     looks like after a write. */
  const { results } = await env.VELOX_DB.prepare(
    `SELECT id, body, author, status, category, reply, replied_at, created_at
       FROM client_ideas
      WHERE client_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ).bind(auth.row.id, PAGE_SIZE).all();

  return json({ ok: true, ideas: results || [] }, 200, auth.origin);
}

/* -------------------------------------------------------------- PATCH, DELETE
 * The old boards let whoever was using them edit, delete and tick off an idea,
 * and taking that away made the replacement worse than what it replaced.
 *
 * Every statement is scoped by BOTH id and client_id. A board can only ever
 * touch its own rows, even if someone sends another board's row id — the
 * WHERE clause simply matches nothing.
 */

/** List the board's ideas. Used after every write so the page never guesses. */
async function listFor(env, clientId) {
  const { results } = await env.VELOX_DB.prepare(
    `SELECT id, body, author, status, category, reply, replied_at, created_at
       FROM client_ideas
      WHERE client_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ).bind(clientId, PAGE_SIZE).all();
  return results || [];
}

export async function onRequestPatch({ request, env }) {
  const auth = await authenticate(request, env);
  if (auth.fail) return auth.fail;

  let incoming;
  try { incoming = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid request' }, 400, auth.origin); }

  const id = Number(incoming.id);
  if (!id) return json({ ok: false, error: 'Which idea?' }, 400, auth.origin);

  const sets = [];
  const binds = [];

  if (incoming.body !== undefined) {
    const body = clean(incoming.body, MAX_BODY);
    if (!body) return json({ ok: false, error: 'An idea cannot be empty' }, 400, auth.origin);
    sets.push('body = ?'); binds.push(body);
  }

  if (incoming.category !== undefined) {
    const raw = clean(incoming.category, 30).toLowerCase();
    sets.push('category = ?');
    binds.push(CATEGORIES.indexOf(raw) === -1 ? 'other' : raw);
  }

  /* Ticking off is a status change, not a separate flag — one source of
     truth, so the monthly report and the board can never disagree. Reopening
     returns it to 'seen' rather than 'new': it has been seen. */
  if (incoming.done !== undefined) {
    sets.push('status = ?');
    binds.push(incoming.done ? 'done' : 'seen');
    sets.push(incoming.done ? "replied_at = COALESCE(replied_at, datetime('now'))" : 'replied_at = replied_at');
  }

  if (!sets.length) return json({ ok: false, error: 'Nothing to change' }, 400, auth.origin);

  binds.push(id, auth.row.id);
  const res = await env.VELOX_DB.prepare(
    `UPDATE client_ideas SET ${sets.join(', ')} WHERE id = ? AND client_id = ?`
  ).bind(...binds).run();

  if (!res.meta || res.meta.changes === 0) {
    return json({ ok: false, error: 'No idea with that id' }, 404, auth.origin);
  }
  return json({ ok: true, ideas: await listFor(env, auth.row.id) }, 200, auth.origin);
}

export async function onRequestDelete({ request, env }) {
  const auth = await authenticate(request, env);
  if (auth.fail) return auth.fail;

  let incoming = {};
  try { incoming = await request.json(); } catch { /* id may be on the query */ }
  const url = new URL(request.url);
  const id = Number(incoming.id || url.searchParams.get('id'));
  if (!id) return json({ ok: false, error: 'Which idea?' }, 400, auth.origin);

  const res = await env.VELOX_DB.prepare(
    'DELETE FROM client_ideas WHERE id = ? AND client_id = ?'
  ).bind(id, auth.row.id).run();

  if (!res.meta || res.meta.changes === 0) {
    return json({ ok: false, error: 'No idea with that id' }, 404, auth.origin);
  }
  return json({ ok: true, ideas: await listFor(env, auth.row.id) }, 200, auth.origin);
}
