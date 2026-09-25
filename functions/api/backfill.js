/**
 * POST /api/backfill  { "limit": 20 }
 *
 * One-off repair job. Two problems it fixes:
 *
 *   1. Your leads have no rating or review_count, so every one of them scores
 *      "No review data (+8)" and the whole list flattens to 53 or 18. There is
 *      no way to tell a beloved cafe from a quiet one.
 *
 *   2. Leads marked social_only by the migration were never scored at all,
 *      because verify.js only looks at rows still marked 'unchecked'. They are
 *      sitting at tier 'unrated', score 0, at the bottom of your list.
 *
 * This walks leads with no rating yet, asks Google for the review data, writes
 * it back, and rescores. It rescores social_only rows on the way through, so
 * both problems go away in the same pass.
 *
 * Costs one Places call per lead. 45 leads is 45 calls against a monthly
 * allowance of at least 1,000.
 *
 * Safe to run repeatedly — it only touches rows where rating IS NULL, and it
 * never overwrites a tier you locked by hand.
 */

import { scoreLead } from './scoring.js';

const MAX_LEADS = 20;   // 20 outbound calls, well under the 50 subrequest cap

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (err) {
    // Without this, any thrown error surfaces as Cloudflare "error code: 1101"
    // with no detail at all. Better to hand back something you can read.
    return json({
      error: String(err?.message || err),
      hint: 'A "no such column" error means that column never made it into D1. '
          + 'Run PRAGMA table_info(leads); in the D1 console to see what you have.',
    }, 500);
  }
}

async function handle({ request, env }) {
  const db = env.VELOX_DB;
  if (!db) return json({ error: 'VELOX_DB binding missing' }, 500);
  if (!env.GOOGLE_PLACES_API_KEY) return json({ error: 'GOOGLE_PLACES_API_KEY missing' }, 500);

  let body = {};
  try { body = await request.json(); } catch { /* defaults fine */ }
  const limit = clamp(Number(body.limit) || 20, 1, MAX_LEADS);

  const res = await db
    .prepare(`SELECT * FROM leads WHERE rating IS NULL ORDER BY id ASC LIMIT ?`)
    .bind(limit)
    .all();

  const leads = res.results || [];
  if (!leads.length) {
    return json({ checked: 0, message: 'Every lead already has review data' });
  }

  const out = [];

  for (const lead of leads) {
    let found = null;
    let note = null;

    try {
      found = await lookupPlace(lead, env.GOOGLE_PLACES_API_KEY);
    } catch (err) {
      note = String(err?.message || err);
    }

    const merged = { ...lead, ...(found || {}) };
    const locked = Number(lead.score_locked) === 1;
    const scored = locked
      ? { lead_score: lead.lead_score, tier: lead.tier, score_reason: lead.score_reason }
      : scoreLead(merged);

    await db
      .prepare(
        `UPDATE leads
            SET rating = ?, review_count = ?, business_status = ?,
                lead_score = ?, tier = ?, score_reason = ?
          WHERE id = ?`
      )
      .bind(
        found?.rating ?? null,
        found?.review_count ?? null,
        found?.business_status ?? null,
        scored.lead_score, scored.tier, scored.score_reason,
        lead.id
      )
      .run();

    out.push({
      id: lead.id,
      name: lead.name,
      rating: found?.rating ?? null,
      reviews: found?.review_count ?? null,
      was: `${lead.tier || 'unrated'} ${lead.lead_score ?? 0}`,
      now: `${scored.tier} ${scored.lead_score}`,
      note,
    });
  }

  const moved = out.filter((r) => r.was !== r.now).length;
  return json({ checked: out.length, rescored: moved, results: out });
}

/**
 * Ask Google for one business by name and suburb.
 *
 * Guards against grabbing the wrong shop: the result's name has to share at
 * least half its significant words with the lead's name, otherwise we take
 * nothing rather than write someone else's 4.9 stars onto your lead.
 */
async function lookupPlace(lead, apiKey) {
  const suburb = String(lead.suburb || '').replace(/,?\s*QLD\s*$/i, '').trim();
  const query = `${lead.name} ${suburb} QLD Australia`;

  const url =
    'https://maps.googleapis.com/maps/api/place/textsearch/json' +
    `?query=${encodeURIComponent(query)}&key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places HTTP ${res.status}`);

  const data = await res.json();
  if (data.status === 'ZERO_RESULTS') return null;
  if (data.status !== 'OK') {
    throw new Error(`Places ${data.status}${data.error_message ? ': ' + data.error_message : ''}`);
  }

  const first = (data.results || [])[0];
  if (!first) return null;

  if (!sameBusiness(lead.name, first.name)) {
    throw new Error(`Top match was "${first.name}" — too different, skipped`);
  }

  return {
    rating: first.rating ?? null,
    review_count: first.user_ratings_total ?? null,
    business_status: first.business_status ?? null,
  };
}

function sameBusiness(a, b) {
  const words = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3);

  const A = words(a);
  const B = new Set(words(b));
  if (!A.length) return false;
  const hits = A.filter((w) => B.has(w)).length;
  return hits / A.length >= 0.5;
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
