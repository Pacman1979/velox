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

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

export const WEBSITE_POINTS = {
  // Domain lapsed or repurposed. Something is actively wrong and they almost
  // certainly do not know. Easiest conversation you will ever have.
  expired: 50,
  // They bought a domain, started, never finished. Intent already proven.
  parked: 45,
  // Genuinely nothing anywhere.
  none: 40,
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
  none: 'No website',
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

  let quality = 0;
  if (reviews === null) {
    quality = 8;
    reasons.push('No review data (+8)');
  } else if (reviews >= 150 && rating >= 4.5) {
    quality = 35;
    reasons.push(`${reviews} reviews at ${rating} (+35)`);
  } else if (reviews >= 50 && rating >= 4.3) {
    quality = 25;
    reasons.push(`${reviews} reviews at ${rating} (+25)`);
  } else if (reviews >= 20 && rating >= 4.0) {
    quality = 15;
    reasons.push(`${reviews} reviews at ${rating} (+15)`);
  } else if (reviews >= 20) {
    quality = 8;
    reasons.push(`${reviews} reviews, rating only ${rating} (+8)`);
  } else {
    quality = 4;
    reasons.push(`Only ${reviews} reviews (+4)`);
  }

  // A genuinely poorly rated business is a hard client and a bad case study.
  if (rating !== null && rating < 3.8 && reviews !== null && reviews >= 20) {
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
        business_quality: {
          '150+ reviews and 4.5+': 35,
          '50+ reviews and 4.3+': 25,
          '20+ reviews and 4.0+': 15,
          '20+ reviews, lower rating': 8,
          'under 20 reviews': 4,
          'no review data': 8,
          'penalty: rating under 3.8 with 20+ reviews': -10,
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
