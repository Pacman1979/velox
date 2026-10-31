/**
 * functions/api/_middleware.js — the lock on every private endpoint
 *
 * ---------------------------------------------------------------------------
 * The hole this closes
 * ---------------------------------------------------------------------------
 * /crm, /today, /clients and /life all showed a PIN keypad, but the PIN was
 * only ever checked in the browser. The endpoints behind them — /api/leads,
 * /api/crm, /api/clients, /api/today, /api/ideas, /api/tasks, /api/life_biz,
 * /api/life_personal, /api/verify-one — had no protection at all. Anyone who
 * found a URL could read the whole lead database, the client list and the
 * personal notes straight from a browser tab, or write rows into them.
 *
 * A gate drawn in HTML is scenery. This is the gate.
 *
 * ---------------------------------------------------------------------------
 * How it decides
 * ---------------------------------------------------------------------------
 * Pages Functions runs this before every function under /api. Three outcomes:
 *
 *   1. Named public endpoints pass straight through. These are the ones a
 *      visitor's browser calls on studiovelox.com, and they must stay open.
 *   2. A request carrying an API key passes through to the endpoint, which
 *      checks the key itself with requireKey(). This is how the velox-cron
 *      Worker and curl reach /api/verify and friends — they send a key, not
 *      a PIN, and demanding a PIN here would break every cron job.
 *   3. Everything else is private and needs the PIN in X-Velox-Pin.
 *
 * Adding a new endpoint therefore locks it by default. That is deliberate:
 * forgetting to add protection is the mistake this file exists to prevent,
 * so the safe state is the one you get by doing nothing.
 */

import { pinLockout, pinFailed, pinPassed, sameSecret } from './_pinguard.js';

/* Visitor-facing. These run on the public site and must never need a PIN. */
const PUBLIC = new Set([
  'checkpin',    // the gate itself
  'chatlead',    // the assistant handing over a name and number
  'chatlog',     // the assistant recording what was asked
  'contact',     // the enquiry form
  'quickaudit',  // the instant site check, deliberately open
  'reportlead',  // the free report landing page at /report
  /* The client suggestion box, called from the CLIENT'S OWN domain. It is
     public to this middleware but not open: it carries its own key + PIN and
     answers only to that client's origin. It cannot use the PIN gate here,
     because the PIN here is Phil's. */
  'client-ideas',
]);

export async function onRequest(context) {
  const { request, env, next } = context;

  /* Preflight carries no custom headers by definition. */
  if (request.method === 'OPTIONS') return next();

  const slug = new URL(request.url).pathname
    .replace(/^\/api\/?/, '')
    .split('/')[0]
    .replace(/\.js$/, '')
    .toLowerCase();

  if (PUBLIC.has(slug)) return next();

  /* A machine caller. Let the endpoint's own requireKey() judge the key —
     this file must not become a second place where key rules live. */
  if (request.headers.get('X-Velox-Key') || request.headers.get('X-Cron-Key')) {
    return next();
  }

  if (!env.SITE_PIN) {
    return json({
      error: 'SITE_PIN is not set on this Pages project. Add it under ' +
             'Settings > Variables and Secrets, then redeploy.',
    }, 503);
  }

  /* This path is guessable too. Without a limit here, a script skips
     /api/checkpin entirely and brute-forces the PIN against /api/leads. */
  const locked = await pinLockout(env, request);
  if (locked) return locked;

  if (sameSecret(request.headers.get('X-Velox-Pin'), env.SITE_PIN)) {
    await pinPassed(env, request);
    return next();
  }

  await pinFailed(env, request);
  return json({ error: 'Locked. Open the page and enter your PIN.' }, 401);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
