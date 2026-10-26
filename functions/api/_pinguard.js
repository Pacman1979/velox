/**
 * Shared PIN brute-force guard.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * A four-digit PIN is ten thousand guesses. With no rate limit, a script walks
 * all ten thousand in a couple of minutes, and the PIN is the only thing now
 * standing between the open internet and the lead database.
 *
 * Lengthening the PIN is the obvious answer and the wrong one: every PIN
 * screen on the site is hard-coded to four digits, so a longer PIN locks you
 * out of your own CRM, and six digits only buys a factor of a hundred against
 * a machine that does not get tired. Rate limiting is what actually closes it.
 * Ten wrong guesses an hour makes four digits take about forty days.
 *
 * ---------------------------------------------------------------------------
 * Which way it fails
 * ---------------------------------------------------------------------------
 * AUTHENTICATION fails closed: no PIN configured means nobody gets in.
 * RATE LIMITING fails open: if KV is unreachable, guesses are still checked
 * against the PIN, they just are not counted. The alternative is a KV outage
 * locking you out of your own CRM, which is a worse day than a slightly wider
 * window on an attack nobody is currently running.
 */

const MAX_FAILURES = 10;      // per IP
const WINDOW_SECONDS = 3600;  // rolling hour

function keyFor(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return 'pinfail:' + ip;
}

/**
 * Has this IP burned its attempts? Returns a Response to send straight back,
 * or null to carry on.
 */
export async function pinLockout(env, request) {
  if (!env.IDEAS_KV) return null;              // fail open, deliberately
  try {
    const n = Number((await env.IDEAS_KV.get(keyFor(request))) || 0);
    if (n >= MAX_FAILURES) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Too many attempts. Try again later.' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
      );
    }
  } catch (_) { /* fail open */ }
  return null;
}

/** Count a wrong PIN. */
export async function pinFailed(env, request) {
  if (!env.IDEAS_KV) return;
  try {
    const k = keyFor(request);
    const n = Number((await env.IDEAS_KV.get(k)) || 0);
    await env.IDEAS_KV.put(k, String(n + 1), { expirationTtl: WINDOW_SECONDS });
  } catch (_) { /* nothing to do about it */ }
}

/** A correct PIN wipes the slate, so normal use never walks into the wall. */
export async function pinPassed(env, request) {
  if (!env.IDEAS_KV) return;
  try { await env.IDEAS_KV.delete(keyFor(request)); } catch (_) {}
}

/**
 * Compare without leaking the answer in how long it takes. The timing signal
 * over the internet is lost in jitter anyway; this costs nothing and removes
 * the argument.
 */
export function sameSecret(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
