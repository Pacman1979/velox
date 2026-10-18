/**
 * POST /api/chatlead  —  someone left their details in the site assistant
 * ---------------------------------------------------------------------------
 * Public endpoint, no key. It is deliberately boring: it takes a name, a way
 * to contact them, and the conversation that led there, and it writes a row.
 *
 * Three things protect it, because anything public gets hammered eventually:
 *   1. A honeypot field real people never fill in.
 *   2. A per-IP cap in KV — ten an hour, then it politely stops.
 *   3. Hard length limits on everything, so a row can't be used as storage.
 *
 * Durability, in order of preference:
 *   1. D1 (env.VELOX_DB) — the row Phil works from.
 *   2. KV (env.IDEAS_KV) — written too, so a D1 outage never loses an enquiry.
 *   3. Email — best effort, only if a sender is configured. Never fatal.
 *
 * If all three fail the visitor is told honestly and given the phone number.
 * We never show a tick we haven't earned.
 */

const MAX_PER_HOUR = 10;
const FALLBACK_TO = 'phil@studiovelox.com';
const DEFAULT_FROM = 'website@studiovelox.com';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Brisbane is UTC+10 all year and never touches daylight saving. */
function brisbaneNow() {
  return new Date(Date.now() + 10 * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 16) + ' AEST';
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request' });
  }

  // A real person never sees this field, let alone fills it in.
  if (body.website) return json({ ok: true });

  const name     = clean(body.name, 80);
  const contact  = clean(body.contact, 120);
  const url      = clean(body.url, 300);
  const interest = clean(body.interest, 120);
  const page     = clean(body.page, 120);
  // The transcript is the only long field, and it is the useful one — it tells
  // Phil what they were actually asking before they left a number.
  const transcript = String(body.transcript || '').slice(0, 6000);

  if (!name || !contact) {
    return json({ ok: false, error: 'Name and contact are both needed' });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // ---- rate limit -------------------------------------------------------
  if (env.IDEAS_KV) {
    try {
      const key = `chatlead:rate:${ip}:${new Date().toISOString().slice(0, 13)}`;
      const seen = Number((await env.IDEAS_KV.get(key)) || 0);
      if (seen >= MAX_PER_HOUR) {
        return json({ ok: false, error: 'Too many for now — please ring instead' });
      }
      await env.IDEAS_KV.put(key, String(seen + 1), { expirationTtl: 7200 });
    } catch (err) {
      console.error('rate limit check failed:', err.message);
    }
  }

  const when = brisbaneNow();
  const cf = request.cf || {};
  const row = {
    name, contact, url, interest, page, transcript, when,
    suburb: clean(cf.city, 60),
    referrer: clean(request.headers.get('Referer'), 200),
  };

  // ---- 1. D1 ------------------------------------------------------------
  let saved = false;
  try {
    if (env.VELOX_DB) {
      await env.VELOX_DB.prepare(
        `INSERT INTO chat_leads
           (name, contact, site_url, interest, page, transcript, suburb, referrer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(name, contact, url, interest, page, transcript, row.suburb, row.referrer).run();
      saved = true;
    }
  } catch (err) {
    console.error('D1 insert failed:', err.message);
  }

  // ---- 2. KV, always, so nothing is ever only in one place ---------------
  try {
    if (env.IDEAS_KV) {
      await env.IDEAS_KV.put(
        `chatlead:${Date.now()}-${crypto.randomUUID()}`,
        JSON.stringify(row)
      );
      saved = true;
    }
  } catch (err) {
    console.error('KV save failed:', err.message);
  }

  // ---- 3. Email, best effort only ---------------------------------------
  // Silently does nothing if no sender is configured. An enquiry that is
  // safely in D1 should never fail because email isn't set up yet.
  const to = env.CONTACT_TO || FALLBACK_TO;
  const from = env.FROM_ADDRESS || DEFAULT_FROM;
  const subject = `Chat enquiry — ${name}`;
  const text =
    `Someone left their details in the assistant on studiovelox.com\n\n` +
    `Name:     ${name}\n` +
    `Contact:  ${contact}\n` +
    `Their site: ${url || '(none given)'}\n` +
    `Asking about: ${interest || '(not specified)'}\n` +
    `On page:  ${page || '/'}\n` +
    `Received: ${when}\n\n` +
    `--- what they said ---\n${transcript || '(nothing)'}\n`;

  try {
    if (env.CF_ACCOUNT_ID && env.CF_EMAIL_TOKEN) {
      await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.CF_EMAIL_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `Studio Velox <${from}>`,
            to,
            subject,
            text,
            html: `<pre style="font:14px/1.6 ui-monospace,monospace;white-space:pre-wrap">${esc(text)}</pre>`,
          }),
        }
      );
    } else if (env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: `Studio Velox <${from}>`, to: [to], subject, text }),
      });
    }
  } catch (err) {
    console.error('notification email failed:', err.message);
  }

  return json({ ok: saved });
}

/** A GET in a browser should explain itself rather than throw. */
export function onRequestGet() {
  return json({
    ok: false,
    endpoint: '/api/chatlead',
    usage: 'POST { name, contact, url?, interest?, page?, transcript? }',
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204 });
}
