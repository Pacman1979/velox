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
import { requireKey } from './auth.js';

const MAX_LEADS = 10;
const MAX_CANDIDATES = 8;
// Cloudflare's free plan allows 50 outbound fetches per invocation. Each lead
// costs (1 if Google listed a site) + up to MAX_CANDIDATES. This budget is
// shared across the whole batch so a big run can never blow the cap mid-way.
const SUBREQUEST_BUDGET = 44;
const FETCH_TIMEOUT_MS = 6000;
const MAX_BODY_CHARS = 150000;

// Pages that exist but have nothing on them.
const PARKED_SIGNATURES = [
  'under construction',
  'coming soon',
  'website coming soon',
  'future home of',
  'parking-page',
  'sedoparking',
  'this site is temporarily unavailable',
  'default web site page',
  'if you are the site owner',
  'your new website is on its way',
  'placeholder page',
];

// A domain investor is sitting on it waiting for an offer. Critically this
// means the domain is NOT the business's — so it must never be reported as
// "parked", which implies they own it and simply never built anything.
// loaf.com.au prints "loaf.com.au may be for sale" in its header, which used
// to match the single word "Loaf" and get filed as a working website.
const FOR_SALE_SIGNATURES = [
  'may be for sale',
  'is for sale',
  'domain for sale',
  'buy this domain',
  'purchase this domain',
  'this domain is parked',
  'domain is parked',
  'make an offer',
  'domain broker',
  'inquire about this domain',
  'the domain name you are looking for',
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

// Third-party pages the business does not own. Google's website field points
// at these surprisingly often — NAVAH was filed as "live" against an
// ozfoodhunter listing, Scott's against foodiemate.
const AGGREGATOR_HOSTS = [
  'ubereats.com', 'doordash.com', 'menulog.com.au', 'deliveroo.com.au',
  'ozfoodhunter.com.au', 'foodiemate.com.au', 'hungryhungry.com',
  'tripadvisor.com', 'tripadvisor.com.au', 'zomato.com', 'yelp.com',
  'yelp.com.au', 'opentable.com', 'opentable.com.au', 'thefork.com.au',
  'restaurantguru.com', 'beanhunter.com', 'happycow.net',
  'yellowpages.com.au', 'truelocal.com.au', 'localsearch.com.au',
  'hotfrog.com.au', 'dimmi.com.au', 'quandoo.com.au', 'now-book-it.com',
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
  const denied = requireKey(request, env);
  if (denied) return denied;

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
          WHERE website_status IS NULL
             OR website_status = 'unchecked'
             OR (website_status IN ('social_only', 'aggregator') AND verify_note IS NULL)
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

  const budget = makeBudget(SUBREQUEST_BUDGET);
  const results = [];
  for (const lead of leads) {
    const finding = await verifyLead(lead, budget);
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
  const denied = requireKey(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isFinite(id)) return json({ error: 'Pass ?id=' }, 400);

  const lead = await env.VELOX_DB
    .prepare('SELECT * FROM leads WHERE id = ?')
    .bind(id)
    .first();
  if (!lead) return json({ error: 'Lead not found' }, 404);

  const finding = await verifyLead(lead, makeBudget(SUBREQUEST_BUDGET));
  const scored = scoreLead({ ...lead, ...finding });
  return json({ dry_run: true, lead: lead.name, ...finding, ...scored });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verifyLead(lead, budget) {
  const tokens = nameTokens(lead.name);
  const notes = [];
  let listedSiteDead = false;
  let fallback = null;   // social or aggregator page, used only if nothing better turns up

  const known = (lead.website || '').trim();
  if (known) {
    // A social or delivery-platform link is NOT an answer — it just means
    // Google has no real website for them. Remember it and keep looking,
    // otherwise leads like Street Corner never get their domains checked.
    if (isSocial(known)) {
      fallback = {
        website_status: 'social_only',
        real_website: known,
        verify_note: `Google lists ${hostOf(known)}, not a website`,
      };
    } else if (isAggregator(known)) {
      fallback = {
        website_status: 'aggregator',
        real_website: known,
        verify_note: `Google lists ${hostOf(known)} — a third-party page they do not own`,
      };
    } else if (budget.spend()) {
      const probe = await probeUrl(known);
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
  }

  const candidates = candidateDomains(lead.name).slice(0, MAX_CANDIDATES);
  let tried = 0;
  let ranOut = false;

  for (const { domain, exact } of candidates) {
    if (!budget.spend()) {
      ranOut = true;
      break;
    }
    tried++;

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

    if (probe.status >= 400) {
      notes.push(`${domain}: not registered`);
      continue;
    }
    // A near-miss domain serving casino or pharma content is worth your eyes,
    // but a guess is never allowed to state it as fact.
    const text = probe.text || '';
    const hijack = HIJACK_SIGNATURES.filter((h) => text.includes(h));
    notes.push(hijack.length >= 2
      ? `${domain}: LOOK AT THIS — serving unrelated content (${hijack.slice(0, 3).join(', ')})`
      : `${domain}: reached, not theirs`);
  }

  // Ran out of fetches before finishing. Leave it unchecked so the next run
  // picks it up again, rather than writing a "none" we never actually proved.
  if (ranOut && !fallback) {
    return {
      website_status: 'unchecked',
      real_website: null,
      verify_note: `Only got through ${tried} of ${candidates.length} domains before the fetch budget ran out. Run again.`,
    };
  }

  // Nothing better found. A social or aggregator page beats calling it "none".
  if (fallback) {
    return {
      ...fallback,
      verify_note: `${fallback.verify_note}. Checked ${tried} domains, none theirs.`,
    };
  }

  // If Google listed a site and it was dead, that is a lapsed website, not an
  // absent one — a different conversation on the doorstep.
  return {
    website_status: listedSiteDead ? 'expired' : 'none',
    real_website: listedSiteDead ? known : null,
    verify_note: notes.length
      ? `Checked ${tried + (known ? 1 : 0)}. ${notes.join('; ')}`
      : `Tried ${candidates.map((c) => c.domain).join(', ')} — nothing found`,
  };
}

/** Shared fetch allowance so one batch can never exceed Cloudflare's cap. */
function makeBudget(max) {
  let used = 0;
  return { spend: () => (used < max ? (used++, true) : false), used: () => used };
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
  if (probe.finalUrl && isAggregator(probe.finalUrl)) {
    return {
      status: 'aggregator',
      note: `Lands on ${hostOf(probe.finalUrl)} — a listing page, not their own site`,
    };
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
  const confident = nameMatches(matched, tokens, exact);

  // A for-sale page belongs to a domain investor. Not theirs, not parked by
  // them, not a website. Report nothing and let the caller keep looking.
  if (FOR_SALE_SIGNATURES.some((f) => text.includes(f))) return null;

  // Parked FIRST, before the name match. A holding page almost always prints
  // the domain name on it, so checking "is their name on the page" first
  // misreads every parking page as a working site.
  const parked = PARKED_SIGNATURES.find((s) => text.includes(s));
  if (parked && text.length < 60000 && (exact || confident)) {
    return {
      status: 'parked',
      note: `Holding page — found "${parked}". Domain is owned but nothing is built.`,
    };
  }

  // A confident name match is safe to trust from any domain.
  if (confident) {
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

  // Nothing of their name anywhere on a substantial page = not their site.
  if (matched.length === 0 && text.length > 2000) {
    return {
      status: 'expired',
      note: 'Domain serves a real page with no trace of their name. Open it before you act on it.',
    };
  }

  // Some of the name matched, but not enough to be sure. Say so rather than
  // either claiming it as theirs or accusing them of a dead domain.
  if (matched.length >= 1 && text.length > 2000) {
    return {
      status: 'live',
      note: `Probably theirs, but only ${matched.length}/${tokens.length} name terms matched — worth an eyeball.`,
    };
  }

  return null;
}

/**
 * Is this page confidently theirs?
 *
 * Half the words used to be enough, which let rootsand.com claim "Roots And
 * Culture Cafe" on the word "roots" alone, and garyngary.com claim
 * "Gary & Maddie" on "gary".
 */
function nameMatches(matched, tokens, exact) {
  if (!tokens.length) return false;
  const ratio = matched.length / tokens.length;
  // A single common word ("Loaf", "Tarte") proves nothing by itself unless
  // the domain is already their full name.
  if (tokens.length === 1) return exact && ratio === 1;
  return matched.length >= 2 && ratio >= 0.6;
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

  // Suffixes in order of how likely an Australian small business is to hold
  // one. .au direct opened in 2022 and is the loose one — auDA requires only
  // an Australian presence, no ABN and no connection to your trading name —
  // so a recently rebranded shop may well be sitting on one.
  const EXACT_TLDS = ['com.au', 'com', 'au', 'net.au'];
  const GUESS_TLDS = ['com.au', 'com', 'au'];

  const out = [];
  for (const slug of slugs) {
    if (slug.length < 4 || slug.length > 40) continue;
    // exact = the guess uses the whole business name, so a mismatch is
    // meaningful. Truncated guesses can only ever confirm, never accuse.
    const exact = slug === full;
    for (const tld of exact ? EXACT_TLDS : GUESS_TLDS) {
      out.push({ domain: `${slug}.${tld}`, exact });
    }
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

function isAggregator(url) {
  const h = hostOf(url);
  return AGGREGATOR_HOSTS.some((a) => h === a || h.endsWith('.' + a));
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
