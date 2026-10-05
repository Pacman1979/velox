// ===========================================================================
// SAVE THIS FILE AT:  ~/VELOX/functions/api/dedupe.js
// New file. Commit and push — Cloudflare redeploys itself.
// ===========================================================================

/**
 * POST /api/dedupe
 *
 * Finds leads that are the same business entered twice, and merges them.
 *
 *   { }                 — DRY RUN. Shows what it would do. Changes nothing.
 *   { "apply": true }   — actually merges and deletes.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Bam Bam Bakehouse is in the database twice, and so is Burleigh Baker —
 * once as "Burleigh Baker", once as "Burleigh Baker Bakehouse".
 *
 * The cause: leads imported before place_id was being stored have nothing
 * exact to match against, so cron-search falls back to comparing name and
 * suburb. Google's name for a shop drifts over time ("Burleigh Baker" becomes
 * "Burleigh Baker Bakehouse"), the strings stop matching, and the same shop
 * comes in again as a new lead.
 *
 * Expect more of these as the cron works through suburbs you already covered
 * by hand.
 *
 * ---------------------------------------------------------------------------
 * The rule that keeps this safe
 * ---------------------------------------------------------------------------
 * Two rows are only ever merged when they are in the SAME SUBURB and one of:
 *
 *   1. identical place_id            — Google's own id. Proof.
 *   2. identical real_website        — two rows pointing at one site.
 *   3. one name is a prefix of the other, after normalising
 *                                    — "burleighbaker" ⊂ "burleighbakerbakehouse"
 *
 * And NEVER when both rows have a place_id and those ids differ — that is
 * positive proof they are two different shopfronts, whatever the names say.
 * Two Lost Boys barbershops in two suburbs stay two leads, as they should.
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

  try {
  const all = (await db.prepare('SELECT * FROM leads ORDER BY id ASC').all()).results || [];
  const groups = findGroups(all);

  const plan = groups.map((group) => {
    const keeper = pickKeeper(group);
    const losers = group.filter((l) => l.id !== keeper.id);
    return {
      keep: { id: keeper.id, name: keeper.name, suburb: keeper.suburb, why: keeper._why },
      remove: losers.map((l) => ({ id: l.id, name: l.name })),
      matched_on: group._reason,
      fields_recovered: fieldsToRecover(keeper, losers),
    };
  });

  if (!apply) {
    return json({
      dry_run: true,
      leads_total: all.length,
      duplicate_groups: plan.length,
      rows_that_would_go: plan.reduce((n, p) => n + p.remove.length, 0),
      plan,
      next_step: plan.length
        ? 'Read the plan. If it looks right, send {"apply": true} to do it.'
        : 'No duplicates found.',
    });
  }

  let merged = 0, deleted = 0;

  for (const group of groups) {
    const keeper = pickKeeper(group);
    const losers = group.filter((l) => l.id !== keeper.id);
    const recover = fieldsToRecover(keeper, losers);

    // DELETE FIRST, THEN ENRICH, AND BOTH IN ONE BATCH.
    //
    // The first version updated the keeper before deleting the losers, which
    // threw a bare Cloudflare 1101. There is a UNIQUE index on place_id: for
    // the moment between the update and the delete, two rows would hold the
    // same id, and SQLite refuses. The dry run never saw it because the dry
    // run writes nothing.
    //
    // db.batch runs the statements in order inside one transaction, so either
    // the whole merge happens or none of it does. A half-merge — losers gone,
    // keeper never enriched — would lose the place_id and coordinates for
    // good, with nothing left to recover them from.
    const statements = losers.map((l) =>
      db.prepare('DELETE FROM leads WHERE id = ?').bind(l.id)
    );

    if (Object.keys(recover).length) {
      const sets = Object.keys(recover).map((k) => `${k} = ?`).join(', ');
      statements.push(
        db.prepare(`UPDATE leads SET ${sets} WHERE id = ?`)
          .bind(...Object.values(recover), keeper.id)
      );
    }

    await db.batch(statements);
    deleted += losers.length;
    if (Object.keys(recover).length) merged++;
  }

  return json({
    dry_run: false,
    duplicate_groups: groups.length,
    rows_enriched: merged,
    rows_deleted: deleted,
    next_step: 'Open the CRM — the duplicates are gone and the survivor kept your notes.',
  });

  } catch (err) {
    // Without this, anything thrown here is a bare Cloudflare 1101 with no
    // clue what went wrong. That is exactly how this bug presented.
    return json({
      error: String(err?.message || err),
      hint: 'A UNIQUE constraint failure means two rows briefly held the same '
          + 'place_id. Nothing was changed — the batch is all-or-nothing.',
    }, 500);
  }
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

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function findGroups(leads) {
  const groups = [];
  const taken = new Set();

  for (let i = 0; i < leads.length; i++) {
    if (taken.has(leads[i].id)) continue;
    const group = [leads[i]];
    let reason = null;

    for (let j = i + 1; j < leads.length; j++) {
      if (taken.has(leads[j].id)) continue;
      const why = sameBusiness(leads[i], leads[j]);
      if (why) {
        group.push(leads[j]);
        reason = reason || why;
      }
    }

    if (group.length > 1) {
      group.forEach((l) => taken.add(l.id));
      group._reason = reason;
      groups.push(group);
    }
  }
  return groups;
}

function sameBusiness(a, b) {
  const pa = str(a.place_id), pb = str(b.place_id);

  // Google's own id. The only proof that needs nothing else.
  if (pa && pb) {
    return pa === pb ? 'identical place_id' : null;   // different ids = different shops, stop here
  }

  // Everything below needs them to be in the same suburb.
  if (norm(a.suburb) !== norm(b.suburb)) return null;

  const wa = site(a), wb = site(b);
  if (wa && wb && wa === wb) return 'same website';


  const na = norm(a.name), nb = norm(b.name);
  if (!na || !nb) return null;
  if (na === nb) return 'identical name and suburb';

  // "Burleigh Baker" grew into "Burleigh Baker Bakehouse" — Google's name for
  // the shop drifted and the strings stopped matching.
  //
  // This compares WHOLE WORDS, not characters. A character prefix merged
  // "The Tropic" into "The Tropicana Motel", because "thetropic" really is
  // the start of "thetropicanamotel" — two unrelated businesses, one row.
  // Word by word, "tropic" and "tropicana" are plainly different.
  const wa2 = words(a.name), wb2 = words(b.name);
  const [shortW, longW] = wa2.length <= wb2.length ? [wa2, wb2] : [wb2, wa2];
  const realWords = shortW.filter((w) => !LEADING_NOISE.has(w)).length;
  if (realWords >= 2 && shortW.length < longW.length
      && shortW.every((w, i) => w === longW[i])) {
    return 'one name is the start of the other';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Which row survives
// ---------------------------------------------------------------------------

/**
 * Keep the row you have put work into. A row you have rung, written notes on,
 * or scored by hand is worth more than a cleaner row the cron just made.
 * Oldest id breaks a tie, so the lead keeps the id you may have written down.
 */
function pickKeeper(group) {
  const scored = group.map((l) => {
    let n = 0;
    const why = [];
    if (str(l.notes))                      { n += 8; why.push('has your notes'); }
    if (l.status && l.status !== 'new')    { n += 6; why.push(`status ${l.status}`); }
    if (Number(l.score_locked) === 1)      { n += 5; why.push('score locked by you'); }
    if (str(l.contact_name))               { n += 4; why.push('named contact'); }
    if (str(l.email))                      { n += 4; why.push('email on file'); }
    if (str(l.date_contacted))             { n += 4; why.push('already contacted'); }
    // Deliberately NOT scoring phone, place_id, rating or coordinates. Those
    // are machine data and the merge copies them onto the survivor anyway, so
    // letting them pick the winner would only make the choice of id random.
    l._why = why.length ? why.join(', ') : 'oldest row, nothing to choose between them';
    return { l, n };
  });

  scored.sort((x, y) => (y.n - x.n) || (x.l.id - y.l.id));
  return scored[0].l;
}

/**
 * Anything the keeper is missing and a loser has. Only ever fills blanks —
 * a value already on the keeper is never overwritten.
 */
function fieldsToRecover(keeper, losers) {
  const FIELDS = [
    'place_id', 'lat', 'lng', 'phone', 'email', 'contact_name', 'address',
    'website', 'real_website', 'rating', 'review_count', 'business_status',
    'category', 'verify_note', 'website_status',
  ];
  const out = {};
  for (const f of FIELDS) {
    if (!blank(keeper[f])) continue;
    for (const l of losers) {
      if (!blank(l[f])) {
        // website_status is only worth taking if it actually says something.
        if (f === 'website_status' && l[f] === 'unchecked') continue;
        out[f] = l[f];
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blank(v) { return v === null || v === undefined || String(v).trim() === ''; }
function str(v) { return blank(v) ? '' : String(v).trim(); }

/** Words too weak to carry a name on their own. */
const LEADING_NOISE = new Set(['the', 'a', 'an', 'at', 'on', 'of', 'and', 'cafe', 'co']);

/** A name as lowercase words, accents folded. */
function words(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Lowercase, accents folded, punctuation gone, spaces gone. */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Hosts that thousands of different businesses share.
 *
 * This list exists because the first dry run proposed merging "Espressions
 * cafe" into "Fletcher's Pantry & Espresso" — two unrelated cafes whose only
 * web presence is an Instagram page. Comparing hostnames alone, every
 * Instagram-only lead in the database is the same business.
 *
 * For these, the PATH is the identity: instagram.com/woodboxcafe is not
 * instagram.com/espressions. For an ordinary domain the hostname is the
 * identity and the path is noise, because /menu and /contact are one site.
 */
const SHARED_HOSTS = [
  'instagram.com', 'facebook.com', 'fb.com', 'linktr.ee', 'tiktok.com',
  'twitter.com', 'x.com', 'linkedin.com', 'youtube.com',
  'ubereats.com', 'doordash.com', 'menulog.com.au', 'deliveroo.com.au',
  'ozfoodhunter.com.au', 'foodiemate.com.au', 'hungryhungry.com',
  'tripadvisor.com', 'tripadvisor.com.au', 'zomato.com', 'yelp.com',
  'yelp.com.au', 'opentable.com', 'restaurantguru.com', 'beanhunter.com',
  'yellowpages.com.au', 'truelocal.com.au', 'localsearch.com.au',
  'hotfrog.com.au', 'quandoo.com.au', 'now-book-it.com', 'square.site',
  'wixsite.com', 'myshopify.com', 'business.site', 'godaddysites.com',
  'weebly.com', 'blogspot.com', 'wordpress.com', 'squarespace.com',
  'bookwhen.com', 'fresha.com', 'booksy.com', 'timely.com',
];

/**
 * A comparable identity for a lead's web presence, or '' when there is none
 * worth comparing. Strips www, http/https and a trailing slash.
 */
function site(l) {
  const u = str(l.real_website) || str(l.website);
  if (!u) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const shared = SHARED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    if (!shared) return host;

    // A shared platform. The handle is the business, so a bare
    // instagram.com with no path identifies nobody — return nothing.
    const path = url.pathname.toLowerCase().replace(/\/+$/, '');
    return path && path !== '' ? host + path : '';
  } catch {
    return '';
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
