/**
 * POST /api/crm
 *
 * Two jobs, both called from the CRM page:
 *   { category, suburb }   — Google Places search (the Search & Import button)
 *   { bulk: true, leads }  — paste-from-spreadsheet import (the CSV tab)
 *
 * ---------------------------------------------------------------------------
 * Why this was rewritten
 * ---------------------------------------------------------------------------
 * The old version inserted into `has_website` and `score`. Migration 004
 * dropped both columns, so every search and every CSV import was failing with
 * "no such column". This file was broken, not working.
 *
 * It was also expensive. The old search did a Place Details lookup for EVERY
 * result to get phone and website — 20 results meant 21 billed Google calls
 * instead of 1, and because it asked for contact fields those were charged at
 * the Enterprise tier, whose free allowance is only ~1,000 calls a month.
 *
 * Both problems go away by having the search delegate to /api/cron-search,
 * which is the one place that knows how to turn a Google result into a lead
 * row. Two importers drift apart; one does not.
 *
 * The response shape is unchanged, so crm.html needs no edits.
 */

import { onRequestPost as cronSearch } from './cron-search.js';
import { scoreLead } from './scoring.js';

export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers });
  }

  try {
    const body = await request.json();

    if (body.bulk && Array.isArray(body.leads)) {
      return await bulkImport(body.leads, env, headers);
    }

    return await placesSearch(body, env, headers);
  } catch (err) {
    return new Response(JSON.stringify({
      error: String(err?.message || err),
      hint: 'A "no such column" error means the database and this file disagree. '
          + 'Run PRAGMA table_info(leads); in the D1 console.',
    }, null, 2), { status: 500, headers });
  }
}

// ---------------------------------------------------------------------------
// Google Places search — delegates to the shared importer
// ---------------------------------------------------------------------------

async function placesSearch({ category, suburb }, env, headers) {
  if (!category || !suburb) {
    return new Response(JSON.stringify({ error: 'category and suburb required' }),
      { status: 400, headers });
  }
  if (!env.VELOX_API_KEY) {
    return new Response(JSON.stringify({ error: 'VELOX_API_KEY is not set on this project' }),
      { status: 503, headers });
  }

  // The key lives on the server and must never reach page source, so this
  // builds the authenticated request here — same pattern as verify-one.js.
  const inner = new Request('https://studiovelox.com/api/cron-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Velox-Key': env.VELOX_API_KEY },
    body: JSON.stringify({ category, suburb }),
  });

  const res = await cronSearch({ request: inner, env });
  const data = await res.json();

  if (!res.ok || data.error) {
    return new Response(JSON.stringify({ error: data.error || 'Search failed' }),
      { status: res.status || 500, headers });
  }

  // Map back to the shape crm.html already expects.
  const d = (data.detail || [])[0] || {};
  return new Response(JSON.stringify({
    ok: true,
    query: `${category} in ${suburb}`,
    total: d.found ?? 0,
    inserted: d.added ?? 0,
    skipped: d.skipped ?? 0,
    healed: d.healed ?? 0,
    error: d.error || null,
  }, null, 2), { headers });
}

// ---------------------------------------------------------------------------
// CSV / spreadsheet bulk import
// ---------------------------------------------------------------------------

async function bulkImport(leads, env, headers) {
  const db = env.VELOX_DB;
  if (!db) {
    return new Response(JSON.stringify({ error: 'VELOX_DB binding missing' }),
      { status: 500, headers });
  }

  let inserted = 0, skipped = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const raw of leads) {
    const name = String(raw.name || '').trim();
    if (!name) { skipped++; continue; }

    const suburb = normaliseSuburb(raw.suburb);
    const website = String(raw.website || '').trim();

    const existing = await db
      .prepare('SELECT id FROM leads WHERE lower(TRIM(name)) = ? AND lower(TRIM(suburb)) = ?')
      .bind(name.toLowerCase(), suburb.toLowerCase())
      .first();
    if (existing) { skipped++; continue; }

    // A pasted row is never "checked" — only verify.js can say that. A social
    // link is the one thing we can tell at a glance.
    const w = website.toLowerCase();
    const isSocial = w.includes('facebook.com') || w.includes('instagram.com')
                  || w.includes('linktr.ee')   || w.includes('tiktok.com');
    const website_status = isSocial ? 'social_only' : 'unchecked';

    const s = scoreLead({
      website_status,
      phone: raw.phone,
      email: raw.email,
      contact_name: raw.contact_name,
    });

    await db
      .prepare(
        `INSERT INTO leads
           (name, category, suburb, address, phone, website, email, contact_name,
            website_status, score_reason, lead_score, tier,
            referral_source, notes, date_found)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        name,
        String(raw.category || '').trim(),
        suburb,
        String(raw.address || '').trim(),
        String(raw.phone || '').trim(),
        website,
        raw.email ? String(raw.email).trim() : null,
        raw.contact_name ? String(raw.contact_name).trim() : null,
        website_status, s.score_reason, s.lead_score, s.tier,
        raw.referral_source || 'csv_import',
        String(raw.notes || '').trim(),
        today
      )
      .run();

    inserted++;
  }

  return new Response(JSON.stringify({
    ok: true,
    inserted,
    skipped,
    next_step: inserted
      ? `Run the verifier to check websites for the ${inserted} new leads`
      : 'Nothing new imported',
  }, null, 2), { headers });
}

/**
 * The CRM's suburb dropdown says "Burleigh Heads, QLD" but the database was
 * normalised to "Burleigh Heads". Storing both spellings is exactly what let
 * one cafe in twice, so strip the state before it is written.
 */
function normaliseSuburb(s) {
  return String(s || '')
    .replace(/,?\s*(QLD|NSW|VIC|SA|WA|TAS|NT|ACT)\s*$/i, '')
    .trim();
}
