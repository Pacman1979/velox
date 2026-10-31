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
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  });
}

/* ---------------------------------------------------------------------- GET */
/* Their ideas and Phil's replies. Scoped by client_id, newest first. */
export async function onRequestGet({ request, env }) {
  const auth = await authenticate(request, env);
  if (auth.fail) return auth.fail;

  const { results } = await env.VELOX_DB.prepare(
    `SELECT id, body, author, status, reply, replied_at, created_at
       FROM client_ideas
      WHERE client_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ).bind(auth.row.id, PAGE_SIZE).all();

  return json({
    ok: true,
    client: auth.row.name,
    ideas: results || [],
  }, 200, auth.origin);
}

/* --------------------------------------------------------------------- POST */
export async function onRequestPost({ request, env }) {
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
    `INSERT INTO client_ideas (client_id, body, author)
     VALUES (?, ?, ?)`
  ).bind(auth.row.id, body, author || null).run();

  /* Hand back the current list so the page never has to guess what it
     looks like after a write. */
  const { results } = await env.VELOX_DB.prepare(
    `SELECT id, body, author, status, reply, replied_at, created_at
       FROM client_ideas
      WHERE client_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  ).bind(auth.row.id, PAGE_SIZE).all();

  return json({ ok: true, ideas: results || [] }, 200, auth.origin);
}
