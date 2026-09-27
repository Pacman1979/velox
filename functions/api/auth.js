/**
 * Studio Velox — API key check
 *
 * /api/verify, /api/backfill and /api/cron-search all spend money: Google
 * Places calls on one, Cloudflare CPU and outbound fetches on the others.
 * None of them had any protection at all, so anyone who found the URL could
 * run up your bill from a browser tab.
 *
 * This is a shared secret, not a PIN. A PIN is for a person at a keyboard;
 * these three are called by curl and by the cron Worker, so they need
 * something a machine can send in a header.
 *
 * Set it once in the Cloudflare dashboard:
 *   velox Pages project -> Settings -> Variables and Secrets
 *   Name:  VELOX_API_KEY
 *   Value: a long random string
 *
 * Then every call carries it:
 *   curl -H 'X-Velox-Key: your-key-here' ...
 *
 * GET /api/auth reports whether the key is configured. It never returns the
 * key itself, and it is safe to open in a browser.
 */

/**
 * Returns null when the caller is allowed through, or a Response to return
 * straight back to them when they are not.
 *
 *   const denied = requireKey(request, env);
 *   if (denied) return denied;
 */
export function requireKey(request, env) {
  const expected = env.VELOX_API_KEY;

  // Fail closed. An unset secret must never mean "let everyone in".
  if (!expected) {
    return deny(
      'VELOX_API_KEY is not set on this Pages project. Add it under ' +
      'Settings > Variables and Secrets, then redeploy.',
      503
    );
  }

  const given =
    request.headers.get('X-Velox-Key') ||
    request.headers.get('X-Cron-Key') ||   // the old cron header still works
    '';

  if (!given) {
    return deny('Missing X-Velox-Key header.', 401);
  }

  if (!timingSafeEqual(given, expected)) {
    return deny('X-Velox-Key does not match.', 403);
  }

  return null;
}

/**
 * Compare without leaking how much of the key was right through response
 * timing. Always walks the full length of both strings.
 */
function timingSafeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function deny(message, status) {
  return new Response(JSON.stringify({ error: message }, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/auth — is the key configured? Never reveals its value. */
export async function onRequestGet({ env }) {
  return new Response(
    JSON.stringify(
      {
        configured: Boolean(env.VELOX_API_KEY),
        header: 'X-Velox-Key',
        protects: ['/api/verify', '/api/backfill', '/api/cron-search'],
      },
      null,
      2
    ),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
