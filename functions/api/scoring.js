// ===========================================================================
// SAVE THIS FILE AT:  ~/VELOX/functions/api/scoring.js
// Replaces the existing file. Commit and push — Cloudflare redeploys itself.
// ===========================================================================

/**
 * Studio Velox — Lead scoring
 *
 * Two jobs:
 *   1. scoreLead()  — the shared function, imported by verify.js and leads.js
 *   2. onRequestGet — GET /api/scoring returns the live rubric as JSON so you
 *                     can see exactly what the weights are without reading code
 *
 * The old model scored on one signal: does Google list a website. That signal
 * turned out to be unreliable (Next Door Burleigh had a Square site Google
 * never knew about) and too narrow (a beloved cafe with 340 reviews and a
 * parked domain is a far better prospect than a quiet one with nothing).
 *
 * So the score is built from three things:
 *   - Website opportunity  (0-50)  how big the gap is
 *   - Business quality     (0-35)  are they actually worth having as a client
 *   - Contactability       (0-15)  can you reach a human
 */

import { requireKey } from './auth.js';

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

export const WEBSITE_POINTS = {
  // Domain lapsed or repurposed. Something is actively wrong and they almost
  // certainly do not know. Easiest conversation you will ever have.
  expired: 50,
  // They bought a domain, started, never finished. Intent already proven.
  parked: 45,
  // Domain bought, page put up, nothing on it. Same proven intent as parked,
  // and there is already something to point at on the doorstep.
  thin: 42,
  // Genuinely nothing anywhere.
  none: 40,
  // Google points at Uber Eats or a directory. Same gap as having nothing,
  // and the pitch writes itself: they are renting their web presence.
  aggregator: 38,
  // Facebook or Instagram only. They have content, no home for it.
  social_only: 25,
  // Not looked at yet — mid weight so it neither hides nor jumps the queue.
  unchecked: 20,
  // Working site. Not a free-build lead; possibly a $997 rebuild.
  live: 5,
};

export const WEBSITE_LABELS = {
  expired: 'Domain expired',
  parked: 'Domain parked',
  thin: 'Stub site',
  none: 'No website',
  aggregator: 'Listing page only',
  social_only: 'Social only',
  unchecked: 'Not checked',
  live: 'Has website',
};

export const TIER_THRESHOLDS = [
  { tier: 'prime', min: 70 },
  { tier: 'strong', min: 50 },
  { tier: 'maybe', min: 30 },
  { tier: 'skip', min: 0 },
];

// ---------------------------------------------------------------------------
// Review volume expectations, by trade
// ---------------------------------------------------------------------------
// A cafe collects reviews because people sit in it with a phone in their hand.
// A mechanic does not. Thirty reviews is quiet for a bakery and busy for a
// mobile mechanic, so one set of thresholds cannot judge both.
//
// Before this, the whole trade half of the queue scored as 'maybe' no matter
// how good the business was, because nothing but hospitality clears 150
// reviews — and 'maybe' is a tier you never visit.
//
// The bands below are a FIRST GUESS. Appendix B of the runbook has the query
// that shows the real distribution per category; tune them once a few hundred
// trade leads are in and the numbers are real rather than estimated.

export const REVIEW_BANDS = {
  // People review these constantly.
  hospitality: {
    categories: ['cafe', 'coffee', 'bakery', 'bakehouse', 'restaurant', 'eatery',
                 'bar', 'pub', 'fish and chips', 'takeaway', 'butcher',
                 'greengrocer', 'grocer', 'patisserie', 'deli', 'juice',
                 'dessert', 'pizza', 'burger*'],
    bands: [[150, 4.5, 35], [50, 4.3, 25], [20, 4.0, 15]],
    thin: 20,
  },
  // Appointment businesses. Steady, but nothing like a cafe's volume.
  personal: {
    categories: ['barber*', 'hair', 'salon', 'nail*', 'beauty', 'massage', 'spa',
                 'pilates', 'yoga', 'gym', 'tattoo*', 'grooming', 'florist',
                 'physio*', 'chiro*', 'podiatr*', 'dog'],
    bands: [[80, 4.5, 35], [30, 4.3, 25], [12, 4.0, 15]],
    thin: 12,
  },
  // Trades. A plumber with 25 reviews at 4.8 is booked three weeks out.
  trade: {
    categories: ['mechanic*', 'automotive', 'auto', 'tyre*', 'panel', 'smash',
                 'landscap*', 'lawn', 'garden*', 'plumb*', 'electric*',
                 'builder*', 'carpent*', 'paint*', 'roof*', 'concret*', 'tile*',
                 'fencing', 'pest', 'clean*', 'removal*', 'air conditioning',
                 'glazier*', 'locksmith*', 'handyman', 'excavat*', 'pool'],
    bands: [[40, 4.5, 35], [15, 4.3, 25], [5, 4.0, 15]],
    thin: 5,
  },
};

// Anything that matches nothing above. Sits between hospitality and trade.
const DEFAULT_BAND = { bands: [[60, 4.5, 35], [25, 4.3, 25], [10, 4.0, 15]], thin: 10 };

/**
 * Which set of expectations applies to this lead.
 *
 * Three kinds of keyword, because a plain substring test put "barber" in the
 * hospitality band — "barber" contains "bar", so every barber was being
 * measured against a cafe's review volume:
 *
 *   'bar'          exact word.   Matches "bar", never "barber".
 *   'landscap*'    word prefix.  Matches landscaping, landscaper, landscapes.
 *   'air conditioning'  has a space, so it is matched against the whole string.
 */
export function bandFor(category) {
  const raw = String(category || '').toLowerCase();
  if (!raw) return { name: 'default', ...DEFAULT_BAND };
  const words = raw.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

  for (const [name, def] of Object.entries(REVIEW_BANDS)) {
    for (const key of def.categories) {
      const hit = key.includes(' ')
        ? raw.includes(key)
        : key.endsWith('*')
          ? words.some((w) => w.startsWith(key.slice(0, -1)))
          : words.includes(key);
      if (hit) return { name, ...def };
    }
  }
  return { name: 'default', ...DEFAULT_BAND };
}

// ---------------------------------------------------------------------------
// Franchises
// ---------------------------------------------------------------------------
// The first live cron run scored Bakers Delight, Just Cuts, Ultra Tune, The
// Cheesecake Shop and Auto Masters as prime or strong "no website" leads.
// Technically true — the OUTLET has no site of its own. Commercially useless:
// head office owns the web presence and the franchisee cannot buy one from
// you. Five wasted doorsteps in one morning.
//
// Matched on whole words against the business name, so "Lost Boys Burleigh"
// is never caught by a brand called "Boys".
export const FRANCHISE_BRANDS = [
  // Food
  'bakers delight', 'brumbys', "baker's delight", 'the cheesecake shop',
  'michels patisserie', 'donut king', 'muffin break', 'gloria jeans',
  "gloria jean's", 'the coffee club', 'zarraffas', "zarraffa's", 'jamaica blue',
  'cafe2u', 'boost juice', 'subway', 'dominos', "domino's", 'red rooster',
  'guzman y gomez', 'zambrero', 'nandos', "nando's", 'oporto', 'hungry jacks',
  "hungry jack's", 'kfc', 'mcdonalds', "mcdonald's", 'grilld', "grill'd",
  'sushi hub', 'roll d', 'crust pizza', 'pizza hut', 'eagle boys',
  'baskin robbins', 'cold rock', 'ben and jerrys', 'san churro', 'chatime',
  'gong cha', 'wendys', "wendy's", 'noodle box', 'schnitz', 'betty blue',
  // Hair and beauty
  'just cuts', 'price attack', 'stefan', 'toni and guy', 'toni & guy',
  'hairhouse', 'hairhouse warehouse', 'laser clinics australia', 'ella bache',
  'endota spa', 'australian skin clinics',
  // Automotive
  'ultra tune', 'auto masters', 'midas', 'kmart tyre', 'bob jane',
  'beaurepaires', 'jax tyres', 'bridgestone select', 'repco authorised',
  'lube mobile', 'ultratune', 'mycar', 'national tyres', 'tyrepower',
  // Other trades and services
  'jims mowing', "jim's mowing", 'jims cleaning', "jim's cleaning",
  'jims group', "jim's group", 'hire a hubby', 'vip home services',
  'poolwerx', 'snap fitness', 'anytime fitness', 'f45', 'plus fitness',
  'curves', 'battery world', 'the groomers', 'aussie pooch mobile',
];

/**
 * Is this business a franchise outlet?
 * Whole-word match, so "boys" never matches inside "Lost Boys Burleigh".
 */
export function franchiseBrand(name) {
  const n = ' ' + String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9'& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() + ' ';
  for (const brand of FRANCHISE_BRANDS) {
    if (n.includes(' ' + brand + ' ')) return brand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * @param {object} lead  a row from the leads table
 * @returns {{ lead_score:number, tier:string, score_reason:string }}
 */
export function scoreLead(lead = {}) {
  const reasons = [];

  // A closed business is worth nothing regardless of everything else.
  const bs = (lead.business_status || '').toUpperCase();
  if (bs === 'CLOSED_PERMANENTLY') {
    return {
      lead_score: 0,
      tier: 'skip',
      score_reason: 'Permanently closed on Google',
    };
  }

  // A franchise outlet cannot buy a website from you — head office owns the
  // web presence. Cap it low so it never reaches your visit list, but keep
  // the row so the same name is not rediscovered every week.
  const franchise = franchiseBrand(lead.name);
  if (franchise) {
    return {
      lead_score: 5,
      tier: 'skip',
      score_reason: `Franchise outlet (${franchise}) — head office controls the website. Not a free-build lead.`,
    };
  }

  let score = 0;

  // --- Website opportunity -------------------------------------------------
  const ws = lead.website_status || 'unchecked';
  const wsPoints = WEBSITE_POINTS[ws] ?? WEBSITE_POINTS.unchecked;
  score += wsPoints;
  reasons.push(`${WEBSITE_LABELS[ws] || ws} (+${wsPoints})`);

  // --- Business quality ----------------------------------------------------
  // The profile you want: people already love them, nobody can find them.
  const rating = num(lead.rating);
  const reviews = num(lead.review_count);

  const band = bandFor(lead.category);

  let quality = 0;
  if (reviews === null) {
    quality = 8;
    reasons.push('No review data (+8)');
  } else {
    const hit = band.bands.find(([minR, minStars]) => reviews >= minR && rating >= minStars);
    if (hit) {
      quality = hit[2];
      reasons.push(`${reviews} reviews at ${rating} (+${hit[2]}, ${band.name} scale)`);
    } else if (reviews >= band.thin) {
      quality = 8;
      reasons.push(`${reviews} reviews, rating only ${rating} (+8)`);
    } else {
      quality = 4;
      reasons.push(`Only ${reviews} reviews for a ${band.name} business (+4)`);
    }
  }

  // A genuinely poorly rated business is a hard client and a bad case study.
  // The review floor moves with the trade too — judging a mechanic harshly on
  // 20 reviews when 20 is a lot for a mechanic is the same mistake again.
  if (rating !== null && rating < 3.8 && reviews !== null && reviews >= band.thin) {
    quality -= 10;
    reasons.push('Rating under 3.8 (-10)');
  }
  score += quality;

  // --- Contactability ------------------------------------------------------
  let contact = 0;
  if (str(lead.email)) {
    contact += 7;
    reasons.push('Email on file (+7)');
  }
  if (str(lead.phone)) {
    contact += 5;
    reasons.push('Phone on file (+5)');
  }
  if (str(lead.contact_name)) {
    contact += 3;
    reasons.push('Named contact (+3)');
  }
  if (contact === 0) reasons.push('No way to contact them yet (+0)');
  score += contact;

  // --- Temporarily closed --------------------------------------------------
  if (bs === 'CLOSED_TEMPORARILY') {
    score = Math.round(score * 0.5);
    reasons.push('Temporarily closed (halved)');
  }

  score = clamp(Math.round(score), 0, 100);

  return {
    lead_score: score,
    tier: tierFor(score),
    score_reason: reasons.join(' · '),
  };
}

export function tierFor(score) {
  for (const t of TIER_THRESHOLDS) {
    if (score >= t.min) return t.tier;
  }
  return 'skip';
}

/**
 * Apply a score to a lead unless Phil has locked the tier by hand.
 * Returns the fields to write, or null if nothing should change.
 */
export function scoreUnlessLocked(lead) {
  if (Number(lead.score_locked) === 1) return null;
  return scoreLead(lead);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// GET /api/scoring — the rubric, so you can sanity check the weights
// ---------------------------------------------------------------------------

export async function onRequestGet() {
  return new Response(
    JSON.stringify(
      {
        website_opportunity: WEBSITE_POINTS,
        review_bands: Object.fromEntries(
          Object.entries(REVIEW_BANDS).map(([k, v]) => [k, {
            reads_as: v.categories.slice(0, 6).join(', ') + '…',
            '+35': `${v.bands[0][0]}+ reviews at ${v.bands[0][1]}+`,
            '+25': `${v.bands[1][0]}+ reviews at ${v.bands[1][1]}+`,
            '+15': `${v.bands[2][0]}+ reviews at ${v.bands[2][1]}+`,
          }])
        ),
        franchises_capped_at: 5,
        business_quality: {
          note: 'Thresholds move with the trade — see review_bands below. '
              + 'A cafe collects reviews all day; a mechanic does not.',
          top_band: 35,
          middle_band: 25,
          lower_band: 15,
          'enough reviews, weak rating': 8,
          'too few reviews to judge': 4,
          'no review data': 8,
          'penalty: rating under 3.8 with enough reviews to mean it': -10,
        },
        contactability: { email: 7, phone: 5, contact_name: 3 },
        modifiers: {
          CLOSED_PERMANENTLY: 'score forced to 0, tier skip',
          CLOSED_TEMPORARILY: 'score halved',
        },
        tiers: TIER_THRESHOLDS,
      },
      null,
      2
    ),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// ---------------------------------------------------------------------------
// POST /api/scoring — re-apply the rubric to every lead
// ---------------------------------------------------------------------------
/**
 * Every change to the weights above leaves the stored scores stale. This walks
 * the table and rescores, so a rule change shows up in the CRM instead of only
 * applying to leads found after it.
 *
 *   { }               — DRY RUN. Shows the biggest movers. Writes nothing.
 *   { "apply": true } — writes the new scores.
 *
 * Rows with score_locked = 1 are never touched. A tier you set by hand stays
 * set, which is the whole point of locking it.
 */
export async function onRequestPost({ request, env }) {
  const denied = requireKey(request, env);
  if (denied) return denied;

  const db = env.VELOX_DB;
  if (!db) return json({ error: 'VELOX_DB binding missing' }, 500);

  let body = {};
  try { body = await request.json(); } catch { /* dry run is the default */ }
  const apply = body.apply === true;

  const rows = (await db.prepare(
    'SELECT * FROM leads WHERE score_locked IS NOT 1'
  ).all()).results || [];

  const moved = [];
  for (const lead of rows) {
    const s = scoreLead(lead);
    const before = lead.lead_score ?? 0;
    if (s.lead_score === before && s.tier === lead.tier) continue;

    moved.push({
      id: lead.id,
      name: lead.name,
      category: lead.category,
      band: bandFor(lead.category).name,
      reviews: lead.review_count,
      rating: lead.rating,
      from: `${before} ${lead.tier || '—'}`,
      to: `${s.lead_score} ${s.tier}`,
      change: s.lead_score - before,
    });

    if (apply) {
      await db.prepare(
        'UPDATE leads SET lead_score = ?, tier = ?, score_reason = ? WHERE id = ?'
      ).bind(s.lead_score, s.tier, s.score_reason, lead.id).run();
    }
  }

  moved.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const promoted = moved.filter((m) => m.to.includes('prime') || m.to.includes('strong'));

  return json({
    dry_run: !apply,
    considered: rows.length,
    changed: moved.length,
    now_worth_visiting: promoted.length,
    biggest_movers: moved.slice(0, 30),
    next_step: apply
      ? 'Open the CRM — the list is re-ordered.'
      : 'Read the movers. If they look right, send {"apply": true}.',
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
