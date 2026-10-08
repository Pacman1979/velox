// ===========================================================================
// SAVE THIS FILE AT:  ~/VELOX/functions/api/today.js
// New file. Commit and push — Cloudflare redeploys itself.
// ===========================================================================

/**
 * GET /api/today
 *
 * Picks this morning's round and hands back everything needed to walk it:
 * which suburb, which doors in which order, what to say at each one, and
 * which ones to ring instead of visit.
 *
 * ---------------------------------------------------------------------------
 * Why a separate endpoint
 * ---------------------------------------------------------------------------
 * The CRM answers "what do I have". This answers "what do I do today", which
 * is a different question and the only one that matters at 9am on a Monday.
 *
 * Sorting 121 leads by score and reading down the list is not a plan. Five
 * leads scattered across the Coast is a day of driving; five on one strip is
 * an hour. So the round is picked by SUBURB first, then ordered by walking
 * distance from the best lead in it.
 *
 * No Directions API call — the coordinates are already in the database
 * (captured free by cron-search), and a nearest-neighbour walk is more than
 * good enough for eight shops on one street. Google's optimiser costs money
 * and would reorder by driving time, which is the wrong measure when you are
 * on foot.
 *
 * Needs no key: it is read-only and the page sits behind the same PIN as the
 * CRM. Nothing here is not already on the CRM page.
 */

import { bandFor } from './scoring.js';

// Statuses that mean there is a gap worth talking about.
const OPPORTUNITY = ['expired', 'parked', 'thin', 'none', 'aggregator', 'social_only'];

// Eight is about a morning. More than that and the last ones never happen.
const MAX_STOPS = 8;

// How far you will walk from one door to the next before it stops being one
// round. 700m is about eight minutes. Anything further is a second trip, and
// pretending otherwise is how a morning turns into a driving day.
// Override per round with ?maxleg=1200.
const MAX_LEG_M = 700;

// Below this, the whole round is on foot and Maps should say so.
const WALKABLE_M = 1500;

export async function onRequest({ request, env }) {
  const headers = { 'Content-Type': 'application/json' };
  const db = env.VELOX_DB;
  if (!db) return json({ error: 'VELOX_DB binding missing' }, 500);

  try {
    const url = new URL(request.url);
    const wantSuburb = url.searchParams.get('suburb');     // override the pick
    const today = new Date().toISOString().slice(0, 10);

    const rows = (await db.prepare(
      `SELECT * FROM leads
        WHERE (status IS NULL OR status IN ('new', 'follow_up'))
          AND website_status IN (${OPPORTUNITY.map(() => '?').join(',')})
          AND COALESCE(lead_score, 0) >= 40
        ORDER BY lead_score DESC`
    ).bind(...OPPORTUNITY).all()).results || [];

    // --- follow-ups come first, wherever they are -------------------------
    // A promise you made beats a cold door every time.
    const followups = (await db.prepare(
      `SELECT * FROM leads
        WHERE follow_up_date IS NOT NULL AND follow_up_date <= ?
          AND (status IS NULL OR status NOT IN ('converted', 'skip'))
        ORDER BY follow_up_date ASC`
    ).bind(today).all()).results || [];

    // --- pick the suburb --------------------------------------------------
    const bySuburb = {};
    for (const l of rows) {
      const s = (l.suburb || 'Unknown').trim();
      (bySuburb[s] = bySuburb[s] || []).push(l);
    }

    const ranked = Object.entries(bySuburb)
      .map(([suburb, leads]) => ({
        suburb,
        leads,
        // The sum of the best few, not the average — one brilliant lead in a
        // suburb of duds is still worth the drive, and an average would bury it.
        weight: leads.slice(0, MAX_STOPS)
          .reduce((n, l) => n + (l.lead_score || 0), 0),
      }))
      .sort((a, b) => b.weight - a.weight);

    const picked = wantSuburb
      ? ranked.find((r) => r.suburb.toLowerCase() === wantSuburb.toLowerCase())
      : ranked[0];

    if (!picked) {
      return json({
        date: today,
        round: null,
        followups: followups.map(dress),
        message: 'Nothing left to visit. Run the cron, or widen the suburbs in the queue.',
      });
    }

    // A mobile mechanic has no door, so it never belongs in the walk.
    const visitable = picked.leads.filter((l) => approachFor(l) === 'visit');
    const calls = picked.leads.filter((l) => approachFor(l) === 'call')
      .slice(0, MAX_STOPS).map(dress);

    const maxLeg = Number(url.searchParams.get('maxleg')) || MAX_LEG_M;
    const { round: chosen, left } = pickCluster(visitable, MAX_STOPS, maxLeg);
    const stops = walkOrder(chosen).map(dress);
    const walk = stops.reduce((n, s) => n + (s.walk_m || 0), 0);

    return json({
      date: today,
      round: {
        suburb: picked.suburb,
        why: plural(picked.leads.length, 'unvisited lead') + ' here'
           + (ranked.length > 1 ? `, the best of ${plural(ranked.length, 'suburb')}` : ''),
        stops,
        calls,
        maps_url: mapsUrl(stops, walk),
        walk_metres: walk,
        on_foot: walk > 0 && walk <= WALKABLE_M,
        // What did not make this round, and why. Nothing is ever dropped
        // silently: a lead with no coordinates used to vanish off the map
        // without a word, and the best lead in Burleigh Heads was one.
        nearby: left.map((l) => ({
          ...dress(l),
          not_in_round: isNum(l.lat) && isNum(l.lng)
            ? 'A drive from this round'
            : 'No coordinates yet — add them in the CRM and it will join the route',
        })),
      },
      followups: followups.map(dress),
      other_suburbs: ranked.slice(1, 6).map((r) => ({
        suburb: r.suburb, leads: r.leads.length, weight: r.weight,
      })),
    }, 200, headers);
  } catch (err) {
    return json({
      error: String(err?.message || err),
      hint: 'A "no such column" error means the database and this file disagree. '
          + 'Run PRAGMA table_info(leads); in the D1 console.',
    }, 500);
  }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Choose which doors make up one round.
 *
 * Starts at the best-scoring lead and grows outward, always taking the
 * nearest door still unclaimed, and stopping the moment the nearest one left
 * is further than maxLeg. Returns the round and everything it left behind,
 * so the page can show the rest instead of losing it.
 *
 * Leads with no coordinates cannot be routed, so they are never in the
 * round — but they are always in `left`, with a reason.
 */
function pickCluster(leads, max, maxLeg) {
  const placed = leads.filter((l) => isNum(l.lat) && isNum(l.lng));
  const unplaced = leads.filter((l) => !isNum(l.lat) || !isNum(l.lng));
  if (!placed.length) return { round: [], left: unplaced };

  const round = [placed[0]];
  const pool = placed.slice(1);

  while (round.length < max && pool.length) {
    // Nearest to anything already in the round, not just to the last one —
    // a round is a cluster, not a chain.
    let bi = -1;
    let bd = Infinity;
    pool.forEach((l, i) => {
      const d = Math.min(...round.map((r) => metresBetween(r, l)));
      if (d < bd) { bd = d; bi = i; }
    });
    if (bd > maxLeg) break;
    round.push(pool.splice(bi, 1)[0]);
  }

  return { round, left: [...pool, ...unplaced] };
}

/**
 * Order the round so you are never doubling back.
 *
 * Google's own URL cannot do this — there is no parameter that reorders
 * waypoints, it simply plots them in the order we hand over. So the ordering
 * has to happen here.
 *
 * The first door stays the best lead: if the morning falls apart after two
 * doors, those two should be the ones worth having. Every order of the rest
 * is then measured and the shortest wins. Seven doors after the first is
 * 5,040 orderings, which a Worker does in under a millisecond, so there is
 * no reason to guess. Above that it falls back to nearest-neighbour tidied
 * up with 2-opt, which is within a few percent and never slow.
 */
function walkOrder(leads) {
  const placed = leads.filter((l) => isNum(l.lat) && isNum(l.lng));
  const unplaced = leads.filter((l) => !isNum(l.lat) || !isNum(l.lng));
  if (placed.length < 3) return legs([...placed, ...unplaced]);

  const first = placed[0];
  const rest = placed.slice(1);
  const best = rest.length <= 7
    ? shortestOrder(first, rest)
    : twoOpt([first, ...nearestFirst(first, rest)]);

  return legs([...best, ...unplaced]);
}

/** Every order of `rest` after `first`; the shortest one wins. */
function shortestOrder(first, rest) {
  let bestPath = null;
  let bestLen = Infinity;

  const walk = (used, path, len) => {
    if (len >= bestLen) return;            // already worse, stop here
    if (path.length === rest.length) {
      bestLen = len;
      bestPath = path.slice();
      return;
    }
    const from = path.length ? path[path.length - 1] : first;
    for (let i = 0; i < rest.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      path.push(rest[i]);
      walk(used, path, len + metresBetween(from, rest[i]));
      path.pop();
      used[i] = false;
    }
  };

  walk(new Array(rest.length).fill(false), [], 0);
  return [first, ...(bestPath || rest)];
}

/** Greedy order, used only as a starting point for 2-opt on big rounds. */
function nearestFirst(from, rest) {
  const out = [];
  const left = rest.slice();
  let at = from;
  while (left.length) {
    let bi = 0;
    let bd = Infinity;
    left.forEach((l, i) => {
      const d = metresBetween(at, l);
      if (d < bd) { bd = d; bi = i; }
    });
    at = left.splice(bi, 1)[0];
    out.push(at);
  }
  return out;
}

/** Untangle any crossings, keeping the first stop where it is. */
function twoOpt(path) {
  const len = (p) => p.slice(1).reduce((n, x, i) => n + metresBetween(p[i], x), 0);
  let best = path.slice();
  let bestLen = len(best);
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const trial = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const l = len(trial);
        if (l < bestLen - 0.5) { best = trial; bestLen = l; moved = true; }
      }
    }
    if (!moved) break;
  }
  return best;
}

/** Record how far each door is from the one before it. */
function legs(order) {
  order.forEach((l, i) => {
    const prev = order[i - 1];
    l._walk = i && isNum(l.lat) && isNum(l.lng) && prev && isNum(prev.lat) && isNum(prev.lng)
      ? Math.round(metresBetween(prev, l))
      : null;
  });
  return order;
}

/** Haversine, in metres. */
function metresBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * One Google Maps link for the whole round. Free — this is just a URL, not
 * the Directions API. Capped at 8 stops, which the URL format allows.
 *
 * Maps plots the waypoints in exactly the order given and has no parameter
 * to reorder them, which is why walkOrder() does that work first.
 */
function mapsUrl(stops, walkM) {
  const pts = stops.filter((s) => isNum(s.lat) && isNum(s.lng));
  if (pts.length < 2) return null;
  const at = (p) => `${p.lat},${p.lng}`;
  const mid = pts.slice(1, -1).map(at).join('|');
  return 'https://www.google.com/maps/dir/?api=1'
    + `&origin=${at(pts[0])}`
    + `&destination=${at(pts[pts.length - 1])}`
    + (mid ? `&waypoints=${encodeURIComponent(mid)}` : '')
    + `&travelmode=${walkM && walkM <= WALKABLE_M ? 'walking' : 'driving'}`;
}

// ---------------------------------------------------------------------------
// What to say, and when
// ---------------------------------------------------------------------------

function dress(l) {
  const band = bandFor(l.category).name;
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    suburb: l.suburb,
    address: l.address,
    phone: l.phone,
    email: l.email,
    contact_name: l.contact_name,
    rating: l.rating,
    review_count: l.review_count,
    lead_score: l.lead_score,
    tier: l.tier,
    website_status: l.website_status,
    real_website: l.real_website,
    verify_note: l.verify_note,
    notes: l.notes,
    status: l.status,
    follow_up_date: l.follow_up_date,
    lat: l.lat,
    lng: l.lng,
    walk_m: l._walk ?? null,
    band,
    approach: approachFor(l),
    best_time: bestTime(band),
    opener: openerFor(l),
    map_link: isNum(l.lat) && isNum(l.lng)
      ? `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${l.name} ${l.suburb || ''}`)}`,
  };
}

/**
 * Visit or ring?
 *
 * A mobile mechanic has no door to knock on. Three of the best-scoring leads
 * in the first live run were mobile, and walking a route that includes them
 * is a wasted leg.
 */
function approachFor(l) {
  const hay = `${l.name || ''} ${l.category || ''}`.toLowerCase();
  if (/\bmobile\b|\bcall[- ]?out\b|\bwe come to you\b/.test(hay)) return 'call';
  if (!l.address || !String(l.address).trim()) return 'call';
  return 'visit';
}

function bestTime(band) {
  if (band === 'hospitality') {
    return '10:00–11:30 — after the breakfast rush, before they pack down';
  }
  if (band === 'personal') {
    return '11:00–14:00 midweek — they talk between appointments';
  }
  if (band === 'trade') {
    return '7:30–9:00 or after 15:30 — before the first job or back at the shop';
  }
  return '10:00–11:30';
}

/**
 * The first sentence out of your mouth, built from what the verifier found.
 *
 * Every one of these leads with what is wrong, not with who you are. The
 * worst opener in the world is "Hi, I build websites".
 */
function openerFor(l) {
  const host = hostOf(l.real_website);
  const n = l.review_count;
  // 5 reads as a typo on a doorstep; 5.0 reads as a fact.
  const r = isNum(l.rating) ? l.rating.toFixed(1) : l.rating;
  const numbers = n && r ? `${n} reviews at ${r}` : null;

  switch (l.website_status) {
    case 'parked':
      return host
        ? `"I noticed you've got ${host} registered, but it's still showing a holding page. `
          + `Did that get started and then stall?"`
        : `"I noticed you own a domain but there's nothing on it yet — did that get started and stall?"`;

    case 'expired':
      return `"I think you should know where your old web address points now."`
        + (host ? ` (It's ${host} — open it on your phone outside before you go in.)` : '');

    case 'aggregator':
      return `"I went looking for you online and all I found was your ${host || 'delivery'} listing. `
        + `Is that costing you commission on every order?"`;

    case 'social_only':
      return numbers
        ? `"${numbers}, an active ${host || 'Instagram'}, and nowhere for any of it to land."`
        : `"You're on ${host || 'social'}, but there's nowhere for people to actually land."`;

    case 'thin':
      return `"You've got a site up but there's almost nothing on it. Did that get started and stall?"`;

    case 'none':
    default:
      // Deliberately not "one of the best-rated <category>" — that produced
      // "best-rated barber" and "best-rated bakery" from the same template,
      // and pluralising a Google category string correctly is a losing game.
      // Asked, not asserted. The verifier is good but it is not infallible —
      // it guesses domains, and a business whose name is mostly common words
      // can slip through as "none" when they have a perfectly good site.
      // "Have I missed it?" costs nothing and cannot embarrass you. If they
      // say yes and give you the address, that IS the opening: their customers
      // could not find it either.
      return numbers
        ? `"You've got ${numbers}. That's one of the best I found anywhere in `
          + `${l.suburb || 'the area'} — but I went looking for your website and `
          + `couldn't find one. Have I missed it?"`
        : `"I went looking for your website and couldn't find one — have I missed it?"`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/** "1 suburb", "6 suburbs" — never "1 suburbs". */
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
      .hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
