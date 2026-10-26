/**
 * POST /api/checkpin   { "pin": "1234" }
 *
 * The gate the PIN screens call. It is deliberately public — it has to be,
 * because it is what you call when you do not have a session yet.
 *
 * Two things changed on 26 October 2026, both because this endpoint is the
 * front door to everything now that the API is locked:
 *
 *   1. It is RATE LIMITED. Before, ten thousand guesses took a script about
 *      two minutes. Ten wrong guesses an hour makes the same attack take
 *      roughly forty days. See _pinguard.js.
 *   2. The wildcard CORS header is gone. It used to answer
 *      Access-Control-Allow-Origin: * , which let any website on the internet
 *      run the brute force from a visitor's browser. Nothing legitimate ever
 *      needed that: the PIN screens are on this domain.
 */

import { pinLockout, pinFailed, pinPassed, sameSecret } from './_pinguard.js';

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'POST' } });
  }
  /* GET is a diagnostic, and only ever answers two things: is a PIN set, and
     how many characters long is it. Neither is a secret — every PIN screen on
     the site already draws exactly that many dots for anyone who visits.
     It exists because the two ways this silently fails look identical from
     the keypad: a trailing space pasted into Cloudflare (length 7, nothing
     will ever match), or the variable never saved at all. */
  if (request.method === 'GET') {
    const set = typeof env.SITE_PIN === 'string' && env.SITE_PIN.length > 0;
    const locked = await pinLockout(env, request);
    return json({
      configured: set,
      length: set ? env.SITE_PIN.length : 0,
      trimmedLength: set ? env.SITE_PIN.trim().length : 0,
      lockedOut: !!locked,
    });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  /* Same-origin only. A cross-site page trying to test PINs gets nothing. */
  const origin = request.headers.get('Origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        return json({ ok: false, error: 'Nope.' }, 403);
      }
    } catch (_) {
      return json({ ok: false, error: 'Nope.' }, 403);
    }
  }

  const locked = await pinLockout(env, request);
  if (locked) return locked;

  let pin = '';
  try {
    const body = await request.json();
    pin = typeof body?.pin === 'string' ? body.pin : '';
  } catch (_) {
    return json({ ok: false, error: 'Expected JSON.' }, 400);
  }

  /* Fail closed: an unset PIN must never read as "let everyone in". */
  if (!env.SITE_PIN) {
    return json({ ok: false, error: 'PIN not configured on this project.' }, 503);
  }

  if (sameSecret(pin, env.SITE_PIN)) {
    await pinPassed(env, request);
    return json({ ok: true });
  }

  await pinFailed(env, request);
  return json({ ok: false });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: HEADERS });
}
