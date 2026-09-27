/**
 * POST /api/cron-search
 *
 * Called by the velox-cron Worker on a schedule, or by you with a curl.
 * Requires the X-Cron-Key header to match the CRON_KEY secret.
 *
 * What it does:
 *   1. Takes the N least recently run rows from search_queue
 *   2. Runs one Google Places text search per row
 *   3. Inserts anything it hasn't seen before into leads
 *   4. Scores each new lead
 *   5. Writes the yield back to the queue so you learn what works
 *
 * Deliberately does NOT fetch Place Details for every result — see the note
 * above placesTextSearch() for why that matters to your bill.
 */

import { scoreLead } from './scoring.js';
import { requireKey } from './auth.js';

const MAX_SEARCHES = 15;

export async function onRequestPost({ request, env }) {
  const denied = requireKey(request, env);
  if (denied) return denied;

  const db = env.VELOX_DB;
  if (!db) return json({ error: 'VELOX_DB binding missing' }, 500);
  if (!env.GOOGLE_PLACES_API_KEY) return json({ error: 'GOOGLE_PLACES_API_KEY missing' }, 500);

  let body = {};
  try { body = await request.json(); } catch { /* defaults are fine */ }
  const want = clamp(Number(body.searches) || 5, 1, MAX_SEARCHES);

  // Least recently run first. NULL last_run (never run) sorts first.
  const queue = await db
    .prepare(
      `SELECT * FROM search_queue
        WHERE active = 1
        ORDER BY (last_run IS NOT NULL), last_run ASC
        LIMIT ?`
    )
    .bind(want)
    .all();

  const rows = queue.results || [];
  if (!rows.length) return json({ searches: 0, message: 'Queue is empty or all paused' });

  const now = new Date().toISOString();
  const summary = [];

  for (const row of rows) {
    const query = `${row.category} in ${row.suburb} QLD Australia`;
    let places = [];
    let error = null;

    try {
      places = await placesTextSearch(query, env.GOOGLE_PLACES_API_KEY);
    } catch (err) {
      error = String(err?.message || err);
    }

    let added = 0;
    let skipped = 0;

    for (const place of places) {
      const exists = await db
        .prepare('SELECT id FROM leads WHERE lower(name) = ? AND lower(suburb) = ?')
        .bind(place.name.toLowerCase(), row.suburb.toLowerCase())
        .first();

      if (exists) { skipped++; continue; }

      const lead = {
        name: place.name,
        category: row.category,
        suburb: row.suburb,
        address: place.address,
        rating: place.rating,
        review_count: place.review_count,
        business_status: place.business_status,
        // Left deliberately empty. verify.js fills website_status in far more
        // reliably than Google's website field ever did, and phone is fetched
        // only for leads you decide to chase.
        website: null,
        phone: null,
        website_status: 'unchecked',
      };

      const s = scoreLead(lead);

      await db
        .prepare(
          `INSERT INTO leads
             (name, category, suburb, address, rating, review_count, business_status,
              website_status, status, referral_source, date_found,
              lead_score, tier, score_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'unchecked', 'new', 'cron_search', ?, ?, ?, ?)`
        )
        .bind(
          lead.name, lead.category, lead.suburb, lead.address,
          lead.rating, lead.review_count, lead.business_status,
          now.slice(0, 10),
          s.lead_score, s.tier, s.score_reason
        )
        .run();

      added++;
    }

    await db
      .prepare(
        `UPDATE search_queue
            SET last_run = ?,
                run_count = run_count + 1,
                results_seen = results_seen + ?,
                new_leads = new_leads + ?,
                note = ?
          WHERE id = ?`
      )
      .bind(now, places.length, added, error, row.id)
      .run();

    summary.push({
      category: row.category,
      suburb: row.suburb,
      found: places.length,
      added,
      skipped,
      error,
    });
  }

  const totalAdded = summary.reduce((n, s) => n + s.added, 0);
  return json({
    ran_at: now,
    searches: summary.length,
    new_leads: totalAdded,
    detail: summary,
    next_step: totalAdded
      ? `Run POST /api/verify {"limit":10} to check the ${totalAdded} new leads`
      : 'Nothing new this run',
  });
}

/**
 * One text search = one billed API call, returning up to 20 businesses.
 *
 * Note what is NOT here: a Place Details call per result. Legacy text search
 * does not return website or phone, so fetching those for 20 results would
 * turn one call into twenty-one. Since Google's website field is unreliable
 * anyway (that is the whole reason verify.js exists), the cheap path is to
 * take names, addresses and review data from the search, let verify.js find
 * the websites properly, and pull a phone number only for a lead you have
 * decided to ring.
 *
 * If your crm.js already has a working search function, use that instead of
 * this one — no sense maintaining two.
 */
async function placesTextSearch(query, apiKey) {
  const url =
    'https://maps.googleapis.com/maps/api/place/textsearch/json' +
    `?query=${encodeURIComponent(query)}&key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Places HTTP ${res.status}`);

  const data = await res.json();
  if (data.status === 'ZERO_RESULTS') return [];
  if (data.status !== 'OK') {
    throw new Error(`Places ${data.status}${data.error_message ? ': ' + data.error_message : ''}`);
  }

  return (data.results || []).map((r) => ({
    name: r.name,
    address: r.formatted_address || null,
    rating: r.rating ?? null,
    review_count: r.user_ratings_total ?? null,
    business_status: r.business_status ?? null,
  }));
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
