// ===========================================================================
// SAVE THIS FILE AT:  ~/VELOX/functions/api/quickaudit.js
// New file. Commit and push — Cloudflare redeploys itself.
// ===========================================================================

/**
 * POST /api/quickaudit      { "url": "example.com.au" }
 *
 * Fetches a visitor's homepage and tells them the truth about it in about
 * three seconds. Everything it reports is measured, not guessed.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Every web designer on the coast says "free audit" and means "fill in this
 * form and wait". This one answers before the visitor has let go of the
 * mouse. It proves you can build things, not just style them — and the URL
 * it needs is the exact thing the lead form was asking for anyway.
 *
 * ---------------------------------------------------------------------------
 * What it will NOT do
 * ---------------------------------------------------------------------------
 * It never returns any of the fetched page's content, only counts and
 * yes/no answers about it. That matters: an endpoint that hands back
 * whatever it downloaded is an open proxy, and ours would be sitting on
 * your domain. It also refuses anything that isn't a public web address,
 * so it can't be pointed at a machine inside a network.
 *
 * No key. It is deliberately public — that is the whole point of it.
 */

// Eight seconds. A site slower than that has its answer already.
const TIMEOUT_MS = 8000;

// Read at most this much HTML. Everything worth checking is near the top,
// and an unbounded read is how you blow the Worker's memory.
const MAX_BYTES = 1_200_000;

// Addresses that are nobody's homepage.
const BLOCKED_HOST = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.local|.*\.internal|.*\.home\.arpa)$|^\[?f[cd][0-9a-f]{2}:/i;

// The signs of a domain that is registered but not used.
const PARKED = [
  'this domain is for sale', 'buy this domain', 'domain for sale',
  'coming soon', 'under construction', 'site is being built',
  'default web page', 'apache2 ubuntu default', 'welcome to nginx',
  'future home of something', 'parked free', 'godaddy.com/domainfind',
];

export async function onRequestPost({ request }) {
  let body = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const target = safeUrl(body.url);
  if (!target) {
    // Deliberately a 200 with ok:false rather than a 400. A 400 would show
    // up as a red error in the visitor's console on our own site, which is
    // a poor look on a page whose whole job is to demonstrate craft.
    return json({
      ok: false,
      message: "That doesn't look like a web address. Try something like yourbusiness.com.au",
    });
  }

  const started = Date.now();
  let res;
  let html = '';
  let truncated = false;

  try {
    res = await fetch(target.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Say who we are. Anyone checking their logs can see it's us.
        'User-Agent': 'StudioVeloxAudit/1.0 (+https://studiovelox.com)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      // Cache for five minutes, so the same address checked twice only
      // touches the other site once.
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    const reader = res.body && res.body.getReader();
    if (reader) {
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > MAX_BYTES) {
          // Keep the part that fits rather than throwing the whole chunk
          // away — a page can arrive as one enormous chunk, and dropping it
          // would leave us measuring an empty string.
          chunks.push(value.subarray(0, Math.max(0, MAX_BYTES - size)));
          size = MAX_BYTES;
          truncated = true;
          reader.cancel();
          break;
        }
        size += value.length;
        chunks.push(value);
      }
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }
      html = new TextDecoder('utf-8', { fatal: false }).decode(all);
    }
  } catch (err) {
    const timedOut = /timeout|aborted|timed out/i.test(String(err && err.message));
    return json({
      ok: true,
      url: target.href,
      reached: false,
      headline: timedOut
        ? "Your site didn't answer within eight seconds."
        : "We couldn't reach your site at all.",
      detail: timedOut
        ? 'Visitors give it about five. If it was just a bad moment, try again — '
          + "but if it does this often, that's the first thing to fix."
        : "Either the address is wrong, the site is down, or it's blocking visitors "
          + "it doesn't recognise. Worth knowing either way.",
      findings: [],
    });
  }

  const ms = Date.now() - started;
  const finalUrl = new URL(res.url || target.href);
  const kb = Math.round(html.length / 1024);
  const head = html.slice(0, 60_000);
  const text = strip(html).toLowerCase();

  // ── the checks ──────────────────────────────────────────────────────
  const bad = [];     // costing them customers
  const watch = [];   // worth a look
  const good = [];    // already right

  const push = (list, title, detail) => list.push({ title, detail });

  if (res.status >= 400) {
    push(bad, `Your homepage returns an error (${res.status})`,
      'Search engines treat this as a broken page. So do visitors.');
  }

  const parked = PARKED.find((sig) => text.includes(sig));
  if (parked) {
    push(bad, 'Your domain is registered but there is no site on it',
      'What loads is a holding page. Anyone who looks you up finds nothing.');
  }

  // Phones
  const hasViewport = /<meta[^>]+name=["']?viewport["']?[^>]*>/i.test(head);
  if (hasViewport) {
    push(good, 'It is built to resize for phones', null);
  } else {
    push(bad, 'It is not built for phones',
      'There is no viewport setting, so a phone shrinks the whole desktop layout '
      + 'to fit. Text comes out unreadable. Most of your visitors are on a phone.');
  }

  // Speed — be precise about what was measured
  if (ms > 4000) {
    push(bad, `Your server took ${(ms / 1000).toFixed(1)} seconds to answer`,
      'That is before a single picture has loaded. Visitors leave at about five.');
  } else if (ms > 1800) {
    push(watch, `Your server took ${(ms / 1000).toFixed(1)} seconds to answer`,
      'Not fatal, but there is room to improve before pictures are even counted.');
  } else if (ms < 250) {
    // "0.0 seconds" reads as a broken measurement, not a fast server.
    push(good, 'Your server answered immediately', null);
  } else {
    push(good, `Your server answered in ${(ms / 1000).toFixed(1)} seconds`, null);
  }

  if (finalUrl.protocol !== 'https:') {
    push(bad, 'It does not load securely',
      "Chrome shows a 'Not secure' warning next to your address. That alone "
      + 'turns people away.');
  } else {
    push(good, 'It loads securely over https', null);
  }

  // Can a phone visitor call you in one tap?
  const tel = /href=["']tel:/i.test(html);
  if (tel) {
    push(good, 'Your phone number is tappable', null);
  } else {
    const looksLikeNumber = /\b0[2-9]\s?\d{4}\s?\d{4}\b|\b04\d{2}\s?\d{3}\s?\d{3}\b/.test(strip(html));
    push(bad, looksLikeNumber
      ? 'Your phone number is on the page but not tappable'
      : 'There is no phone number on your homepage',
      looksLikeNumber
        ? 'On a phone it does nothing when tapped. The number has to be a link.'
        : 'Someone ready to call you right now has nothing to tap.');
  }

  // What a shared link looks like
  const ogImage = /<meta[^>]+property=["']?og:image["']?[^>]*>/i.test(head);
  if (ogImage) {
    push(good, 'Shared links show a picture', null);
  } else {
    push(watch, 'Sharing your link shows a blank grey box',
      'Text it to someone, or post it on Facebook, and there is no picture and '
      + 'often no description. It reads as broken.');
  }

  const title = (head.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i) || [])[1];
  const titleText = title ? decode(title).trim() : '';
  if (!titleText) {
    push(bad, 'Your page has no title',
      "The browser tab and your Google listing both show the address instead.");
  } else if (titleText.length < 15) {
    push(watch, `Your page title is just "${titleText}"`,
      'This is the headline Google shows. It should say what you do and where.');
  } else {
    push(good, 'Your page has a proper title', null);
  }

  const desc = /<meta[^>]+name=["']?description["']?[^>]*>/i.test(head);
  if (!desc) {
    push(watch, 'There is no description for Google to show',
      'Google writes its own from whatever text it finds first, which is rarely '
      + 'the sentence you would have chosen.');
  } else {
    push(good, 'You have a description for search results', null);
  }

  if (!/<h1[\s>]/i.test(html)) {
    push(watch, 'Your homepage has no main heading',
      'Nothing on the page is marked as the headline, which costs you in search '
      + 'and makes the page harder to scan.');
  }

  const imgs = (html.match(/<img[\s>]/gi) || []).length;
  const noAlt = (html.match(/<img(?![^>]*\balt=)[^>]*>/gi) || []).length;
  if (imgs === 0) {
    push(watch, 'Your homepage has no pictures',
      'Hard to judge a business with nothing to look at.');
  } else if (noAlt > 0) {
    push(watch, `${noAlt} of your ${imgs} pictures have no description`,
      'Screen readers skip them, and Google cannot tell what they show.');
  }

  const blocking = (head.match(/<script(?![^>]*\b(defer|async|type=["']?application\/ld\+json))[^>]*\bsrc=/gi) || []).length;
  if (blocking >= 3) {
    push(watch, `${blocking} scripts load before your page can appear`,
      'Each one makes the visitor wait. Most of them do not need to.');
  }

  if (kb > 400) {
    push(watch, `Your homepage code alone is ${kb} KB`,
      'That is the text of the page before any picture or font. On mobile data '
      + 'it is a slow start.');
  }

  // A stale copyright year is the clearest sign of an abandoned site.
  const years = [...strip(html).matchAll(/(?:©|&copy;|copyright)[^0-9]{0,12}((?:19|20)\d{2})/gi)]
    .map((m) => Number(m[1]));
  const thisYear = new Date().getUTCFullYear();
  const newest = years.length ? Math.max(...years) : null;
  if (newest && newest < thisYear - 1) {
    push(bad, `Your footer still says ${newest}`,
      'To a visitor that reads as "nobody has touched this in years".');
  }

  if (truncated) {
    push(watch, 'Your homepage was too large to read in full',
      'We stopped at about 1 MB of code. A page that big is slow for everyone.');
  }

  // ── what to say about it ────────────────────────────────────────────
  const n = bad.length;
  let headline;
  let detail;
  if (n === 0 && watch.length === 0) {
    headline = 'Your site stood up to everything we checked.';
    detail = "Genuinely — nothing here needs fixing. If it still isn't bringing "
      + 'you work, the problem is what the page says, not how it is built, and '
      + 'that is worth a conversation.';
  } else if (n === 0) {
    headline = `Nothing broken, and ${count(watch.length, 'thing')} worth a look.`;
    detail = 'The foundations are sound. These are the details that separate a '
      + 'site that works from one that sells.';
  } else {
    headline = `We found ${count(n, 'thing')} costing you customers.`;
    detail = n === 1
      ? 'One fix, and it is the kind most owners never hear about.'
      : 'Every one of these is fixable, and none of them are your fault.';
  }

  return json({
    ok: true,
    url: finalUrl.href,
    reached: true,
    checked_at: new Date().toISOString(),
    server_ms: ms,
    html_kb: kb,
    headline,
    detail,
    counts: { costing: bad.length, watch: watch.length, good: good.length },
    findings: bad,
    worth_a_look: watch,
    already_right: good.filter((g) => g.title),
  });
}

/** A GET gives the browser something readable instead of an error. */
export function onRequestGet() {
  return json({
    ok: true,
    usage: 'POST { "url": "example.com.au" } and get back what is wrong with it.',
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Turn whatever the visitor typed into a URL we are willing to fetch, or
 * null. Accepts "example.com", "www.example.com/", "https://example.com".
 */
function safeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 300) return null;

  // People paste "www.x.com" and type "x.com". Both mean https.
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;   // some other scheme
    s = 'https://' + s;
  }

  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && !['', '80', '443'].includes(u.port)) return null;

  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) return null;            // needs a real domain
  if (BLOCKED_HOST.test(host)) return null;        // nothing inside a network
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;  // no bare IPs at all
  return u;
}

/** Tags out, so we are reading words rather than markup. */
function strip(html) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

function decode(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function count(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
