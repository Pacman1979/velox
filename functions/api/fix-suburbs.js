// ===========================================================================
// SAVE THIS FILE AT:  ~/VELOX/functions/api/fix-suburbs.js
// New file. Commit and push — Cloudflare redeploys itself.
// ===========================================================================

/**
 * POST /api/fix-suburbs
 *
 *   { }                 — DRY RUN. Shows what it would change. Changes nothing.
 *   { "apply": true }   — writes the corrected suburbs.
 *
 * ---------------------------------------------------------------------------
 * Why
 * ---------------------------------------------------------------------------
 * cron-search used to file every result under the suburb it SEARCHED, not the
 * suburb the business is actually in. Google returns results in a radius, not
 * inside a boundary, so a search for "bakery in Burleigh Heads" brings back
 * Palm Beach shops too.
 *
 * Paris Brest French Bakery — one shop on the Gold Coast Highway at Palm Beach
 * — is in the database twice because of it: once as Palm Beach, once as
 * Burleigh Heads. It also means the morning page would send you walking around
 * Burleigh looking for a bakery that is five kilometres south, and the
 * per-suburb yield numbers in search_queue are measuring the wrong thing.
 *
 * The address Google returned was right all along. This reads it back out.
 *
 * Run this ONCE after deploying the fixed cron-search.js, then run
 * /api/dedupe — rows that were kept apart only by a wrong suburb will finally
 * match each other.
 */

import { requireKey } from './auth.js';

export async function onRequestPost({ request, env }) {
  const denied = requireKey(request, env);
  if (denied) return denied;

  const db = env.VELOX_DB;
  if (!db) return json({ error: 'VELOX_DB binding missing' }, 500);

  let body = {};
  try { body = await request.json(); } catch { /* dry run is the default */ }
  const apply = body.apply === true;

  const rows = (await db.prepare(
    'SELECT id, name, suburb, address FROM leads WHERE address IS NOT NULL AND address != \'\''
  ).all()).results || [];

  const changes = [];
  let unparseable = 0;

  for (const r of rows) {
    const real = suburbFromAddress(r.address);
    if (!real) { unparseable++; continue; }
    if (norm(real) === norm(r.suburb)) continue;

    changes.push({
      id: r.id,
      name: r.name,
      from: r.suburb,
      to: real,
      address: r.address,
    });

    if (apply) {
      await db.prepare('UPDATE leads SET suburb = ? WHERE id = ?')
        .bind(real, r.id).run();
    }
  }

  return json({
    dry_run: !apply,
    leads_with_an_address: rows.length,
    address_not_in_the_expected_shape: unparseable,
    would_change: changes.length,
    changes,
    next_step: apply
      ? 'Now run /api/dedupe — rows kept apart only by a wrong suburb will match now.'
      : 'Read the changes. If they look right, send {"apply": true}.',
  });
}

/** GET is the dry run, so you can look at it in a browser. */
export async function onRequestGet(ctx) {
  return onRequestPost({
    ...ctx,
    request: new Request(ctx.request.url, {
      method: 'POST',
      headers: ctx.request.headers,
      body: '{}',
    }),
  });
}

/**
 * Pull the suburb out of a Google formatted_address.
 *
 *   "1073 Gold Coast Hwy, Palm Beach QLD 4221, Australia"  ->  "Palm Beach"
 *   "Tweed Heads NSW 2485, Australia"                      ->  "Tweed Heads"
 *
 * Must stay identical to the copy in cron-search.js.
 */
function suburbFromAddress(address) {
  if (!address) return null;
  const m = String(address)
    .match(/(?:^|,)\s*([^,]+?)\s+(?:QLD|NSW|VIC|SA|WA|TAS|NT|ACT)\s+\d{4}\b/i);
  return m ? m[1].trim() : null;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
