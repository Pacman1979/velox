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

    // Split before ordering. A mobile mechanic has no door, so leaving one in
    // the route sends you walking 200m to stand outside a business that is not
    // there — which is exactly what the first version did.
    const chosen = picked.leads.slice(0, MAX_STOPS);
    const stops = walkOrder(chosen.filter((l) => approachFor(l) === 'visit')).map(dress);
    const calls = chosen.filter((l) => approachFor(l) === 'call').map(dress);

    return json({
      date: today,
      round: {
        suburb: picked.suburb,
        why: plural(picked.leads.length, 'unvisited lead') + ' here'
           + (ranked.length > 1 ? `, the best of ${plural(ranked.length, 'suburb')}` : ''),
        stops,
        calls,
        maps_url: mapsUrl(stops),
        walk_metres: stops.reduce((n, s) => n + (s.walk_m || 0), 0),
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
 * Order the stops so you are never doubling back.
 *
 * Starts at the best lead — if the morning falls apart after two doors, those
 * two should be the ones worth having — then repeatedly walks to the nearest
 * one left. Anything without coordinates goes on the end rather than being
 * dropped; a lead with no lat/lng is still a lead.
 */
function walkOrder(leads) {
  const placed = leads.filter((l) => isNum(l.lat) && isNum(l.lng));
  const unplaced = leads.filter((l) => !isNum(l.lat) || !isNum(l.lng));
  if (placed.length < 2) return [...placed, ...unplaced];

  const out = [placed[0]];
  const left = placed.slice(1);

  while (left.length) {
    const from = out[out.length - 1];
    let best = 0;
    let bestD = Infinity;
    left.forEach((l, i) => {
      const d = metresBetween(from, l);
      if (d < bestD) { bestD = d; best = i; }
    });
    const next = left.splice(best, 1)[0];
    next._walk = Math.round(bestD);
    out.push(next);
  }

  return [...out, ...unplaced];
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
 */
function mapsUrl(stops) {
  const pts = stops.filter((s) => isNum(s.lat) && isNum(s.lng));
  if (pts.length < 2) return null;
  const at = (p) => `${p.lat},${p.lng}`;
  const mid = pts.slice(1, -1).map(at).join('|');
  return 'https://www.google.com/maps/dir/?api=1'
    + `&origin=${at(pts[0])}`
    + `&destination=${at(pts[pts.length - 1])}`
    + (mid ? `&waypoints=${encodeURIComponent(mid)}` : '')
    + '&travelmode=driving';
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
