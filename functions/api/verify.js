/**
 * Studio Velox — Lead website verification
 *
 * POST /api/verify   { "limit": 5 }            verify the 5 oldest unchecked leads
 * POST /api/verify   { "ids": [12, 18, 23] }   verify specific leads
 * GET  /api/verify?id=12                       dry run — reports, writes nothing
 *
 * What it does, per lead:
 *   1. Builds up to 4 candidate domains from the business name
 *      ("Canteen Coffee and Kitchen" -> canteencoffee.com.au, .com, etc)
 *   2. Fetches each one
 *   3. Classifies what came back: none / parked / expired / social_only / live
 *   4. Rescores the lead and writes it back to D1
 *
 * Subrequest budget: Cloudflare allows 50 outbound fetches per request on the
 * free plan, 1000 on paid. 10 leads x 4 candidates = 40, so MAX_LEADS is 10.
 * If you are on the paid plan you can raise it.
 */

import { scoreLead } from './scoring.js';

const MAX_LEADS = 10;
const MAX_CANDIDATES = 4;
const FETCH_TIMEOUT_MS = 6000;
const MAX_BODY_CHARS = 150000;

// Pages that exist but have nothing on them.
const PARKED_SIGNATURES = [
  'under construction',
  'coming soon',
  'website coming soon',
  'this domain is parked',
  'domain is parked',
  'buy this domain',
  'this domain is for sale',
  'domain for sale',
  'future home of',
  'parking-page',
  'sedoparking',
  'this site is temporarily unavailable',
  'default web site page',
  'if you are the site owner',
  'your new website is on its way',
  'placeholder page',
];

// Someone else now owns the domain and is doing something unrelated.
const HIJACK_SIGNATURES = [
  'casino',
  'pokies',
  'free spins',
  'no deposit bonus',
  'wagering requirement',
  'sportsbook',
  'betting site',
  'viagra',
  'cialis',
  'payday loan',
  'escort',
  'crypto trading bot',
  'forex signals',
];

const SOCIAL_HOSTS = [
  'facebook.com',
  'fb.com',
  'instagram.com',
  'linktr.ee',
  'linktree.ee',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
];

// Words that are too generic to identify a business by.
const STOPWORDS = new Set([
  'the', 'and', 'a', 'of', 'at', 'on', 'in', 'to', 'for',
  'cafe', 'café', 'coffee', 'kitchen', 'espresso', 'bar', 'shop',
  'store', 'co', 'company', 'pty', 'ltd', 'group', 'australia',
  'restaurant', 'bakery', 'eatery', 'roasters', 'roastery',
]);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function onRequestPost({ request, env }) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const db = env.VELOX_DB;
  if (!db) return json({ error: 'VELOX_DB binding missing' }, 500);

  let leads;
  if (Array.isArray(body.ids) && body.ids.length) {
    const ids = body.ids.slice(0, MAX_LEADS).map(Number).filter(Number.isFinite);
    if (!ids.length) return json({ error: 'No valid ids' }, 400);
    const holes = ids.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT * FROM leads WHERE id IN (${holes})`)
      .bind(...ids)
      .all();
    leads = res.results || [];
  } else {
    const limit = clamp(Number(body.limit) || 5, 1, MAX_LEADS);
    const res = await db
      .prepare(
        `SELECT * FROM leads
          WHERE website_status = 'unchecked' OR website_status IS NULL
          ORDER BY id ASC
          LIMIT ?`
      )
      .bind(limit)
      .all();
    leads = res.results || [];
  }

  if (!leads.length) {
    return json({ checked: 0, results: [], message: 'Nothing left to verify' });
  }

  const results = [];
  for (const lead of leads) {
    const finding = await verifyLead(lead);
    const merged = { ...lead, ...finding };
    const scored = Number(lead.score_locked) === 1
      ? { lead_score: lead.lead_score, tier: lead.tier, score_reason: lead.score_reason }
      : scoreLead(merged);

    await db
      .prepare(
        `UPDATE leads
            SET website_status = ?,
                real_website   = ?,
                verify_note    = ?,
                verified_at    = ?,
                lead_score     = ?,
                tier           = ?,
                score_reason   = ?
          WHERE id = ?`
      )
      .bind(
        finding.website_status,
        finding.real_website,
        finding.verify_note,
        new Date().toISOString(),
        scored.lead_score,
        scored.tier,
        scored.score_reason,
        lead.id
      )
      .run();

    results.push({
      id: lead.id,
      name: lead.name,
      website_status: finding.website_status,
      real_website: finding.real_website,
      verify_note: finding.verify_note,
      lead_score: scored.lead_score,
      tier: scored.tier,
      locked: Number(lead.score_locked) === 1,
    });
  }

  return json({ checked: results.length, results });
}

/** Dry run — see what it would find without touching the database. */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isFinite(id)) return json({ error: 'Pass ?id=' }, 400);

  const lead = await env.VELOX_DB
    .prepare('SELECT * FROM leads WHERE id = ?')
    .bind(id)
    .first();
  if (!lead) return json({ error: 'Lead not found' }, 404);

  const finding = await verifyLead(lead);
  const scored = scoreLead({ ...lead, ...finding });
  return json({ dry_run: true, lead: lead.name, ...finding, ...scored });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verifyLead(lead) {
  const tokens = nameTokens(lead.name);

  // If Google gave us a website, that is the first thing to check.
  const notes = [];
  let listedSiteDead = false;

  const known = (lead.website || '').trim();
  if (known) {
    if (isSocial(known)) {
      return {
        website_status: 'social_only',
        real_website: known,
        verify_note: 'Google listing points at a social profile, not a website',
      };
    }
    const probe = await probeUrl(known);
    // Google gave us this address for this business, so a mismatch is
    // meaningful — that is exactly how Canteen's pokies site surfaced.
    const verdict = classify(probe, tokens, true);
    if (verdict) {
      return {
        website_status: verdict.status,
        real_website: probe.finalUrl || known,
        verify_note: verdict.note,
      };
    }
    if (!probe.reached) {
      listedSiteDead = true;
      notes.push(`listed site ${hostOf(known)}: no response`);
    } else if (probe.status >= 400) {
      listedSiteDead = true;
      notes.push(`listed site ${hostOf(known)}: HTTP ${probe.status}`);
    }
  }

  // Now guess domains from the business name.
  const candidates = candidateDomains(lead.name).slice(0, MAX_CANDIDATES);

  for (const { domain, exact } of candidates) {
    const probe = await probeUrl(`https://${domain}`);
    if (!probe.reached) {
      notes.push(`${domain}: no response`);
      continue;
    }
    const verdict = classify(probe, tokens, exact);
    if (verdict) {
      return {
        website_status: verdict.status,
        real_website: probe.finalUrl || `https://${domain}`,
        verify_note: verdict.note,
      };
    }

    // Canteen's real domain was canteencoffee.com.au — a shortened guess, so
    // the code above will not accuse it. But if a near-miss domain is serving
    // casino or pharma content it is worth your eyes, so say so without
    // claiming it as fact.
    if (probe.status >= 400) {
      notes.push(`${domain}: HTTP ${probe.status}`);
      continue;
    }
    const text = probe.text || '';
    const hijack = HIJACK_SIGNATURES.filter((s) => text.includes(s));
    if (hijack.length >= 2) {
      notes.push(`${domain}: LOOK AT THIS — serving unrelated content (${hijack.slice(0, 3).join(', ')})`);
    } else {
      notes.push(`${domain}: reached, not theirs`);
    }
  }

  // Every candidate exhausted. If Google listed a site and it was dead, that
  // is a lapsed website, not an absent one — a different conversation.
  return {
    website_status: listedSiteDead ? 'expired' : 'none',
    real_website: listedSiteDead ? known : null,
    verify_note: notes.length
      ? `Checked ${candidates.length + (known ? 1 : 0)}. ${notes.join('; ')}`
      : `Tried ${candidates.map((c) => c.domain).join(', ')} — nothing found`,
  };
}

/**
 * Decide what a fetched page actually is.
 * Returns null when the page tells us nothing useful.
 *
 * @param exact  true when this URL is genuinely tied to the business — either
 *               Google listed it, or the domain is the full business name.
 *               When false we are guessing, so a page that does not mention
 *               them means "not theirs", never "their domain expired".
 */
function classify(probe, tokens, exact) {
  if (!probe.reached) return null;

  if (probe.finalUrl && isSocial(probe.finalUrl)) {
    return { status: 'social_only', note: `Redirects to ${hostOf(probe.finalUrl)}` };
  }

  // A 4xx/5xx means the domain resolves but serves nothing.
  // An HTTP error is NOT a verdict. A dead .com.au tells us nothing about
  // whether they own a working .com — which is exactly how Lakeview's real
  // site got missed. Record it and let the caller keep looking.
  if (probe.status >= 400) return null;

  const text = probe.text || '';
  if (!text) return null;

  const hijack = HIJACK_SIGNATURES.filter((s) => text.includes(s));
  const matched = tokens.filter((t) => text.includes(t));
  const matchRatio = tokens.length ? matched.length / tokens.length : 0;

  // Parked FIRST, before the name match. A holding page almost always prints
  // the domain name on it, so checking "is their name on the page" first
  // misreads every parking page as a working site.
  const parked = PARKED_SIGNATURES.find((s) => text.includes(s));
  if (parked && text.length < 60000 && (exact || matchRatio >= 0.5)) {
    return {
      status: 'parked',
      note: `Holding page — found "${parked}". Domain is owned but nothing is built.`,
    };
  }

  // A positive name match is safe to trust from any domain.
  if (matchRatio >= 0.5) {
    return {
      status: 'live',
      note: `Working site, business name found on the page (${matched.length}/${tokens.length} terms).`,
    };
  }

  // Everything below is an accusation about the business, so it needs
  // a domain we can actually attribute to them.
  if (!exact) return null;

  if (hijack.length >= 2) {
    return {
      status: 'expired',
      note: `Domain now serves unrelated content (matched: ${hijack.slice(0, 3).join(', ')}). Open it yourself before you mention it to them.`,
    };
  }

  if (text.length > 2000) {
    return {
      status: 'expired',
      note: 'Domain serves a real page but their name is nowhere on it. Worth eyeballing before you act on it.',
    };
  }

  return null;
}

async function probeUrl(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StudioVeloxLeadCheck/1.0; +https://studiovelox.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    const ct = res.headers.get('content-type') || '';
    let text = '';
    if (ct.includes('html') || ct.includes('text')) {
      text = (await res.text()).slice(0, MAX_BODY_CHARS).toLowerCase();
    }

    return { reached: true, status: res.status, finalUrl: res.url, text };
  } catch (err) {
    return { reached: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Domain guessing
// ---------------------------------------------------------------------------

/**
 * "Canteen Coffee and Kitchen" ->
 *   canteencoffeeandkitchen.com.au, canteencoffeeandkitchen.com,
 *   canteencoffee.com.au, canteencoffee.com
 *
 * The two-word variant is what actually found Canteen's real domain, so it
 * matters as much as the full name.
 */
export function candidateDomains(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return [];

  const full = words.join('');
  const slugs = new Set([full]);
  if (words.length >= 2) slugs.add(words.slice(0, 2).join(''));
  if (words.length >= 3) slugs.add(words.slice(0, 3).join(''));

  // Deliberately NOT adding a single-word guess for multi-word names.
  // "Hidden Perk" would produce hidden.com, which belongs to somebody else
  // entirely — and a stranger's website would look like an expired domain.

  const out = [];
  for (const slug of slugs) {
    if (slug.length < 4 || slug.length > 40) continue;
    // exact = the guess uses the whole business name, so a mismatch is
    // meaningful. Truncated guesses can only ever confirm, never accuse.
    const exact = slug === full;
    out.push({ domain: `${slug}.com.au`, exact });
    out.push({ domain: `${slug}.com`, exact });
  }
  return out;
}

function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function isSocial(url) {
  const h = hostOf(url);
  // Match whole hostnames only. A substring test would flag velox.com.au as
  // social, because "velox.com.au" contains "x.com".
  return SOCIAL_HOSTS.some((s) => h === s || h.endsWith('.' + s));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

// ---------------------------------------------------------------------------

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
