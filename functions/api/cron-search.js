/**
 * POST /api/cron-search
 *
 * Called by the velox-cron Worker on a schedule, or by you with a curl.
 * Requires the X-Velox-Key header.
 *
 * What it does, per queued category × suburb:
 *   1. One Google Places text search (one billed call, up to 20 businesses)
 *   2. Matches each result against the leads you already have
 *   3. Inserts anything new, scored
 *   4. HEALS existing rows that are missing place_id or coordinates
 *   5. Writes the yield back to search_queue so you learn what works
 *
 * Deliberately does NOT fetch Place Details per result — see placesTextSearch().
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

  let rows;

  if (body.category && body.suburb) {
    // Ad-hoc mode: search one combination right now instead of taking the next
    // from the queue. This exists so the CRM's "Search & Import" button can
    // call THIS endpoint rather than keeping a second copy of the import logic
    // in crm.js — two importers drift apart, and the one in crm.js is already
    // dropping place_id and coordinates.
    rows = [{
      id: null,
      category: String(body.category),
      // The CRM dropdown sends "Burleigh Heads, QLD"; the database was
      // normalised to "Burleigh Heads". Storing both spellings is what let one
      // cafe in twice, so strip the state here for every caller.
      suburb: String(body.suburb).replace(/,?\s*(QLD|NSW|VIC|SA|WA|TAS|NT|ACT)\s*$/i, '').trim(),
    }];
  } else {
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

    rows = queue.results || [];
    if (!rows.length) return json({ searches: 0, message: 'Queue is empty or all paused' });
  }

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

    let added = 0, skipped = 0, healed = 0;

    for (const place of places) {
      const existing = await findExisting(db, place, row.suburb);

      if (existing) {
        // Already known. Fill in anything missing without touching the rest —
        // this is how leads imported before place_id existed get their id and
        // coordinates, without a separate backfill pass.
        if (await healLead(db, existing, place)) healed++;
        skipped++;
        continue;
      }

      const lead = {
        name: place.name,
        category: row.category,
        suburb: row.suburb,
        address: place.address,
        rating: place.rating,
        review_count: place.review_count,
        business_status: place.business_status,
        // Left empty on purpose. verify.js finds websites far more reliably
        // than Google's website field, and a phone number is only worth
        // fetching for a lead you have decided to ring.
        website: null,
        phone: null,
        website_status: 'unchecked',
      };

      const s = scoreLead(lead);

      try {
        await db
          .prepare(
            `INSERT INTO leads
               (name, category, suburb, address, rating, review_count, business_status,
                place_id, lat, lng,
                website_status, status, referral_source, date_found,
                lead_score, tier, score_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unchecked', 'new', 'cron_search', ?, ?, ?, ?)`
          )
          .bind(
            lead.name, lead.category, lead.suburb, lead.address,
            lead.rating, lead.review_count, lead.business_status,
            place.place_id, place.lat, place.lng,
            now.slice(0, 10),
            s.lead_score, s.tier, s.score_reason
          )
          .run();
        added++;
      } catch (err) {
        // The UNIQUE index on place_id can still fire if the same business
        // turns up under two categories in one run. Not an error worth
        // failing the whole job for.
        skipped++;
      }
    }

    if (row.id !== null) await db
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
      healed,
      error,
    });
  }

  const totalAdded = summary.reduce((n, s) => n + s.added, 0);
  const totalHealed = summary.reduce((n, s) => n + s.healed, 0);

  return json({
    ran_at: now,
    searches: summary.length,
    new_leads: totalAdded,
    healed_existing: totalHealed,
    detail: summary,
    next_step: totalAdded
      ? `Run POST /api/verify {"limit":10} to check the ${totalAdded} new leads`
      : 'Nothing new this run',
  });
}

/**
 * Find this business among the leads already stored.
 *
 * place_id first, because it is exact — Google's own identifier for that
 * shopfront. Name matching is the fallback for rows imported before place_id
 * was being stored, and it is the weaker test: matching on name and suburb is
 * what let "Palm Springs Burleigh" in twice under two spellings of its suburb.
 */
async function findExisting(db, place, suburb) {
  if (place.place_id) {
    const byId = await db
      .prepare('SELECT id, place_id, lat, lng, rating FROM leads WHERE place_id = ?')
      .bind(place.place_id)
      .first();
    if (byId) return byId;
  }

  return await db
    .prepare(
      `SELECT id, place_id, lat, lng, rating FROM leads
        WHERE lower(TRIM(name)) = ? AND lower(TRIM(suburb)) = ?`
    )
    .bind(
      String(place.name || '').trim().toLowerCase(),
      String(suburb || '').trim().toLowerCase()
    )
    .first();
}

/**
 * Fill in fields an older row is missing. COALESCE means anything already
 * stored wins — this only ever adds, never overwrites.
 * Returns true if it actually changed something.
 */
async function healLead(db, existing, place) {
  const needsId     = !existing.place_id && place.place_id;
  const needsCoords = (existing.lat === null || existing.lat === undefined) && place.lat !== null;
  const needsRating = (existing.rating === null || existing.rating === undefined) && place.rating !== null;

  if (!needsId && !needsCoords && !needsRating) return false;

  try {
    await db
      .prepare(
        `UPDATE leads
            SET place_id     = COALESCE(place_id, ?),
                lat          = COALESCE(lat, ?),
                lng          = COALESCE(lng, ?),
                rating       = COALESCE(rating, ?),
                review_count = COALESCE(review_count, ?)
          WHERE id = ?`
      )
      .bind(
        place.place_id, place.lat, place.lng,
        place.rating, place.review_count,
        existing.id
      )
      .run();
    return true;
  } catch {
    // Two local rows claiming the same place_id would trip the unique index.
    // Leave the row as it is rather than failing the run.
    return false;
  }
}

/**
 * One text search = one billed API call, returning up to 20 businesses.
 *
 * place_id and geometry.location come back in THIS response at no extra cost.
 * That is the whole reason to capture them here rather than later — a separate
 * Place Details call per result would turn one billed call into twenty-one.
 *
 * If crm.js already has a working search function, use that instead of this
 * one — no sense maintaining two.
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
    place_id: r.place_id ?? null,
    lat: r.geometry?.location?.lat ?? null,
    lng: r.geometry?.location?.lng ?? null,
  }));
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
