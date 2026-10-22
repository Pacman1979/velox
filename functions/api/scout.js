/**
 * POST /api/scout    { name, suburb?, lat?, lng?, note? }
 * GET  /api/scout                                   — this week's scouts, best first
 *
 * The roadside capture endpoint, called by /scout.html.
 *
 * ---------------------------------------------------------------------------
 * Why it does NOT call Google Places
 * ---------------------------------------------------------------------------
 * The obvious design is: speak a name, look it up on Places, read the answer
 * back. That spends billed Places quota on every business you drive past, at
 * a moment when you cannot safely read the answer anyway.
 *
 * So this saves the name raw and nothing else. /api/verify already runs every
 * morning at 7am over leads that have NEVER been checked, guessing candidate
 * domains and fetching them — no billed API behind it. By the time you sit
 * down, the lead has been checked, scored and is waiting in the list below.
 *
 * ---------------------------------------------------------------------------
 * Why scouted leads are kept apart
 * ---------------------------------------------------------------------------
 * A scraped lead arrives with a rating and a review count. A scouted one does
 * not, so scoreLead() gives it the no-review-data floor of +8 where a scraped
 * lead can collect up to +35. Ranked in one list a scouted lead sinks to
 * 'maybe' and never gets visited, however good it is.
 *
 * They are scored on exactly the same rubric — the score is comparable, the
 * RANKING is not. So they are stamped referral_source = 'scout' and listed on
 * their own, where they compete only against each other.
 *
 * The missing review data is not really missing, either. You stood outside the
 * place and looked at it, which is better information than a star rating.
 */

import { scoreLead } from './scoring.js';

const SOURCE = 'scout';
const LIST_LIMIT = 60;

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

/* The page is PIN-walled, but a PIN enforced only in the browser protects
   nothing — the endpoint has to check it too, or anyone who finds the URL can
   write rows into the lead database. */
function denied(request, env) {
  if (!env.SITE_PIN) return json({ error: 'SITE_PIN is not set on this project.' }, 503);
  const given = request.headers.get('X-Velox-Pin') || '';
  if (given !== env.SITE_PIN) return json({ error: 'Locked.' }, 401);
  return null;
}

export async function onRequestPost({ request, env }) {
  const no = denied(request, env);
  if (no) return no;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Expected JSON.' }, 400); }

  const name = str(body.name).slice(0, 120);
  if (!name) return json({ error: 'A business name is required.' }, 400);

  const suburb = str(body.suburb).slice(0, 80);
  const note   = str(body.note).slice(0, 400);
  const lat    = numOrNull(body.lat);
  const lng    = numOrNull(body.lng);

  try {
    /* Same duplicate rule as /api/leads, so scouting something the Sunday
       search already found does not create a second row for one business. */
    const existing = await env.VELOX_DB.prepare(
      'SELECT id, name, suburb, website_status, lead_score, tier, referral_source ' +
      'FROM leads WHERE lower(name) = ? AND lower(suburb) = ?'
    ).bind(name.toLowerCase(), suburb.toLowerCase()).first();

    if (existing) {
      return json({
        ok: true,
        duplicate: true,
        id: existing.id,
        name: existing.name,
        spoken: `${existing.name} is already on the list.`,
        lead: existing,
      });
    }

    const draft = {
      name,
      suburb,
      category: '',
      website_status: 'unchecked',
      rating: null,
      review_count: null,
      email: '',
      phone: '',
    };
    const scored = scoreLead(draft);

    const res = await env.VELOX_DB.prepare(
      `INSERT INTO leads
         (name, category, suburb, address, phone, website, email, contact_name,
          website_status, score_reason, lead_score, tier,
          referral_source, notes, lat, lng, date_found)
       VALUES (?, '', ?, '', '', '', '', '',
          'unchecked', ?, ?, ?,
          ?, ?, ?, ?, datetime('now'))`
    ).bind(
      name, suburb,
      scored.score_reason, scored.lead_score, scored.tier,
      SOURCE, note, lat, lng
    ).run();

    const id = res?.meta?.last_row_id ?? null;

    return json({
      ok: true,
      duplicate: false,
      id,
      name,
      suburb,
      lead_score: scored.lead_score,
      tier: scored.tier,
      /* What gets read back aloud. Deliberately short: confirmation that it
         heard you, nothing to look at or think about. */
      spoken: suburb ? `Saved. ${name}, ${suburb}.` : `Saved. ${name}.`,
    });
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  const no = denied(request, env);
  if (no) return no;

  try {
    const { results } = await env.VELOX_DB.prepare(
      `SELECT id, name, suburb, website_status, real_website, lead_score, tier,
              notes, date_found, verified_at
         FROM leads
        WHERE referral_source = ?
        ORDER BY
          /* Unverified first — they are the ones the morning run has not
             reached yet, and seeing them confirms the capture worked. */
          CASE WHEN website_status = 'unchecked' THEN 0 ELSE 1 END,
          lead_score DESC,
          date_found DESC
        LIMIT ?`
    ).bind(SOURCE, LIST_LIMIT).all();

    return json({ ok: true, count: results.length, leads: results });
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: HEADERS });
}
