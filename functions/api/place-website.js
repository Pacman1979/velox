/**
 * POST /api/place-website     { "limit": 10, "dry": true }
 *
 * Asks Google the one question the lead search never asks: what website did
 * this business give you?
 *
 * ---------------------------------------------------------------------------
 * The bug this fixes
 * ---------------------------------------------------------------------------
 * `cron-search.js` uses Places **Text Search**, which returns the name,
 * address, rating and review count — and NOT the website. So every lead is
 * stored with `website: null`.
 *
 * `verify.js` has a good branch for a lead whose website is already known: it
 * probes the URL, spots social and delivery-platform pages, and checks the
 * page really belongs to them. That branch never runs, because there is never
 * anything to probe. Instead verify falls back to GUESSING the domain from the
 * business name, and when it cannot confirm a guess it writes `none`.
 *
 * So `none` in the CRM has been meaning "I could not guess their domain",
 * not "they have no website". Businesses at an unguessable address —
 * bobtheplumbergc.com.au — or whose name is three common words have been
 * filed as free-build leads when they already have a site.
 *
 * ---------------------------------------------------------------------------
 * What it costs, and how not to be surprised by it
 * ---------------------------------------------------------------------------
 * The website field lives in Place Details, which is a separate billed request
 * per business — a different SKU from Text Search, with its own free monthly
 * allowance. One call per lead, once.
 *
 * `fields=website,formatted_phone_number` is specified deliberately: Place
 * Details bills by FIELD GROUP, not per field, and both of these sit in the
 * same Contact Data group. So the phone number costs nothing on a call that
 * was being made anyway. Asking for everything WOULD cost more, because it
 * reaches into other groups for data already held.
 *
 * The phone matters as much as the website. `cron-search` stores phone: null
 * for every lead it finds, which left 14 of 282 leads with a number to ring
 * and made the call sheet's "has a phone" filter hide almost everything.
 * A number already in the row is never overwritten: one typed by hand beats
 * Google's.
 *
 * `places_checked_at` records that Google has been ASKED about a lead, which
 * is a different fact from what Google answered. Before it existed, a lead
 * Google had no website for kept a NULL website and a 'none' status, so it
 * matched the candidate query again on the very next run and was paid for
 * twice. Two runs on 31 October billed the same 24 leads over again.
 *
 * **`dry: true` makes no Google calls at all.** It reports which leads would
 * be looked up and how many requests that is, so the bill can be estimated
 * before a cent is spent. Run `{"dry":true}` first, then `{"limit":10}`, look
 * at Google billing, then the rest.
 *
 * ---------------------------------------------------------------------------
 * What it does to a row
 * ---------------------------------------------------------------------------
 * Stores the website and resets the row to `unchecked`, clearing `verified_at`.
 * That is what puts it back in front of /api/verify, which only ever looks at
 * leads never checked before — so the 7am run re-reads it with a real URL in
 * hand and classifies it properly. Nothing else is touched; a status set by
 * hand is left alone (see score_locked below).
 */

import { requireKey } from './auth.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;          // Workers allow 50 subrequests per invocation
const DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json';

export async function onRequestPost({ request, env }) {
  const denied = requireKey(request, env);
  if (denied) return denied;

  if (!env.GOOGLE_PLACES_API_KEY) {
    return json({ error: 'GOOGLE_PLACES_API_KEY missing' }, 500);
  }

  /* A malformed body must NOT fall through to the defaults, because the
     defaults spend money. Two `-d` flags on one curl are joined with `&`,
     producing {"dry":true}&{"limit":50} — not valid JSON. Swallowing that
     and running 10 billed lookups is exactly the surprise this endpoint
     exists to avoid. An empty body is still fine; a broken one is not. */
  let body = {};
  const raw = await request.text();
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch (_) {
      return json({
        error: 'That body is not valid JSON, so nothing was run and nothing was spent.',
        got: raw.slice(0, 200),
        hint: 'Use ONE -d flag. Two are joined with "&" and stop being JSON. ' +
              'Try: -d \'{"dry":true}\' or -d \'{"limit":50}\'',
      }, 400);
    }
  }

  const dry = body.dry === true || body.dry === 1;
  const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  /* How many phone numbers this run gained. Counted separately from websites
     because a lead can easily have one and not the other, and the call sheet
     cares about the phone. */
  let phones = 0;
  const db = env.VELOX_DB;

  /* Who is worth asking about. Only leads that
       - Google can identify (we have a place_id),
       - we have never stored a website for, and
       - the guesser gave up on or has not reached.
     A row whose status you set by hand is excluded: score_locked = 1 means
     you have already decided, and this must not argue with you. */
  const WHERE = `
       place_id IS NOT NULL AND place_id <> ''
   AND (website IS NULL OR website = '')
   AND website_status IN ('none', 'unchecked')
   AND places_checked_at IS NULL
   AND COALESCE(score_locked, 0) <> 1`;

  try {
    const total = await db
      .prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${WHERE}`)
      .first();
    const outstanding = Number(total?.n || 0);

    const { results: rows } = await db
      .prepare(
        `SELECT id, name, suburb, website_status, place_id
           FROM leads
          WHERE ${WHERE}
          ORDER BY lead_score DESC, id ASC
          LIMIT ?`
      )
      .bind(limit)
      .all();

    if (dry) {
      return json({
        ok: true,
        dry: true,
        outstanding,
        would_call: rows.length,
        note: `${outstanding} leads have no stored website. This run would make ` +
              `${rows.length} Place Details requests and spend nothing now. ` +
              `Re-run without "dry" to do it.`,
        sample: rows.slice(0, 10).map((r) => ({
          id: r.id, name: r.name, suburb: r.suburb, now: r.website_status,
        })),
      });
    }

    const found = [];
    const blank = [];
    const failed = [];
    let quotaHit = false;

    for (const row of rows) {
      /* Once Google says the daily quota is gone, every further request is a
         wasted round trip that may still count against it. Stop, and say how
         many are left rather than filling the report with 49 identical
         errors. */
      if (quotaHit) break;

      let site = null;
      let tel = null;
      try {
        const res = await fetch(
          `${DETAILS}?place_id=${encodeURIComponent(row.place_id)}` +
          `&fields=website,formatted_phone_number&key=${env.GOOGLE_PLACES_API_KEY}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.status === 'OK') {
          site = (data.result && data.result.website) || null;
          tel  = (data.result && data.result.formatted_phone_number) || null;
        } else if (data.status === 'ZERO_RESULTS' || data.status === 'NOT_FOUND') {
          site = null;   // Google cannot find the place any more
          tel  = null;
        } else {
          throw new Error(`${data.status}${data.error_message ? ': ' + data.error_message : ''}`);
        }
      } catch (err) {
        const msg = String(err.message || err);
        if (/OVER_QUERY_LIMIT|RESOURCE_EXHAUSTED|quota/i.test(msg)) quotaHit = true;
        failed.push({ id: row.id, name: row.name, error: msg });
        continue;
      }

      if (site) {
        /* Store it and hand the row back to the verifier, which only ever
           looks at leads it has never checked. */
        await db
          .prepare(
            `UPDATE leads
                SET website = ?, website_status = 'unchecked',
                    phone = COALESCE(NULLIF(phone, ''), ?),
                    places_checked_at = datetime('now'),
                    verified_at = NULL,
                    verify_note = 'Website from Google, awaiting re-check'
              WHERE id = ?`
          )
          .bind(site, tel, row.id)
          .run();
        found.push({ id: row.id, name: row.name, suburb: row.suburb,
                     website: site, phone: tel });
        if (tel) phones++;
      } else {
        /* Google has no website for them either. That is now a real "none",
           confirmed rather than guessed, so say so in the note. */
        await db
          .prepare(
            `UPDATE leads
                SET phone = COALESCE(NULLIF(phone, ''), ?),
                    places_checked_at = datetime('now'),
                    verify_note = 'No website on their Google listing either — confirmed'
              WHERE id = ?`
          )
          .bind(tel, row.id)
          .run();
        blank.push({ id: row.id, name: row.name, suburb: row.suburb, phone: tel });
        if (tel) phones++;
      }
    }

    const attempted = found.length + blank.length + failed.length;

    /* Ask the database what is left rather than subtracting. The old
       arithmetic assumed every lead touched leaves the queue, which is
       exactly the assumption that was wrong. */
    let remaining = Math.max(outstanding - attempted, 0);
    try {
      const after = await db
        .prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${WHERE}`)
        .first();
      remaining = Number(after?.n ?? remaining);
    } catch (err) {
      console.error('could not recount outstanding:', err.message);
    }

    if (quotaHit) {
      return json({
        ok: false,
        quota_exhausted: true,
        attempted,
        had_a_website: found.length,
        phone_numbers_added: phones,
        genuinely_none: blank.length,
        still_outstanding: remaining,
        found,
        blank,
        note:
          'Google refused the rest: the daily request quota for this API is gone, ' +
          'so I stopped instead of burning more round trips. Two things to check in ' +
          'console.cloud.google.com: (1) APIs & Services → Places API → Quotas, for a ' +
          'custom daily cap you set earlier, and (2) whether the project has an ' +
          'active billing account at all — Google caps everything hard without one, ' +
          'even inside the free tier. Nothing was lost; re-run tomorrow or after ' +
          'raising the cap and it picks up where it left off.',
      }, 200);
    }

    return json({
      ok: true,
      calls_made: attempted,
      outstanding_before: outstanding,
      outstanding_after: remaining,
      had_a_website: found.length,
      phone_numbers_added: phones,
      genuinely_none: blank.length,
      errors: failed.length,
      found,
      blank,
      failed,
      note: found.length
        ? `${found.length} of ${rows.length} had a website Google knew about and the ` +
          `guesser missed. They are back in the verify queue and the 7am run will ` +
          `reclassify them. The other ${blank.length} are confirmed as having nothing.`
        : `None of these ${rows.length} had a website on their Google listing. ` +
          `Their "none" is now confirmed rather than guessed.`,
    });
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  const denied = requireKey(request, env);
  if (denied) return denied;
  return json({
    ok: true,
    usage: 'POST {"dry":true} to count without spending, then {"limit":10} to run.',
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
