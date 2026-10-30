/**
 * POST /api/reportlead  —  someone asked for the free report
 * ---------------------------------------------------------------------------
 * Public endpoint, no key, same shape as /api/chatlead and deliberately boring.
 *
 * It writes into chat_leads rather than a table of its own, with
 * interest = 'Free report'. That is on purpose: a new table means a migration,
 * a D1 console paste and a second place to look for a lead. The existing table
 * already holds a name, a contact and where they came from, which is all a
 * report request is.
 *
 * Three things protect it, because anything public gets hammered eventually:
 *   1. A honeypot field real people never fill in.
 *   2. A per-IP cap in KV — ten an hour, then it politely stops.
 *   3. Hard length limits, so a row can't be used as storage.
 *
 * Durability, in order of preference:
 *   1. D1 (env.VELOX_DB) — the row Phil works from.
 *   2. KV (env.IDEAS_KV) — written too, so a D1 outage never loses a lead.
 *   3. Email — best effort only, never fatal.
 *
 * NOTE ON DELIVERY: this endpoint does not send the PDF. The page hands the
 * file over in the browser the visitor is already in. That removes email
 * deliverability from the critical path entirely — nothing to land in a spam
 * folder, nothing between wanting the report and having it. The page also
 * downloads it even if this endpoint fails, which is the right trade: they
 * asked for a report, and a database problem at our end is not their problem.
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

/* Deliberately loose. The job here is to reject obvious rubbish, not to be the
   authority on what a valid address looks like — real addresses are stranger
   than most patterns allow, and rejecting a real lead costs more than storing
   a bad one. */
function looksLikeEmail(s) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s);
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

  const name  = clean(body.name, 80);
  const email = clean(body.email, 120);
  const page  = clean(body.page, 120) || '/report';

  if (!name) return json({ ok: false, error: 'A first name, please' });
  if (!looksLikeEmail(email)) return json({ ok: false, error: 'That email looks wrong' });

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // ---- rate limit (fails OPEN — a KV outage must not block a lead) ------
  if (env.IDEAS_KV) {
    try {
      const key = `reportlead:rate:${ip}:${new Date().toISOString().slice(0, 13)}`;
      const seen = Number((await env.IDEAS_KV.get(key)) || 0);
      if (seen >= MAX_PER_HOUR) {
        return json({ ok: false, error: 'Too many from here for now' });
      }
      await env.IDEAS_KV.put(key, String(seen + 1), { expirationTtl: 7200 });
    } catch (err) {
      console.error('rate limit check failed:', err.message);
    }
  }

  const when = brisbaneNow();
  const cf = request.cf || {};
  const suburb = clean(cf.city, 60);
  const referrer = clean(request.headers.get('Referer'), 200);

  const row = {
    name, contact: email, interest: 'Free report', page, when, suburb, referrer,
  };

  // ---- 1. D1 ------------------------------------------------------------
  let saved = false;
  try {
    if (env.VELOX_DB) {
      await env.VELOX_DB.prepare(
        `INSERT INTO chat_leads
           (name, contact, site_url, interest, page, transcript, suburb, referrer, created_at)
         VALUES (?, ?, '', 'Free report', ?, ?, ?, ?, datetime('now'))`
      ).bind(
        name, email, page,
        'Downloaded "The 5 things Gold Coast customers check before they call you"',
        suburb, referrer
      ).run();
      saved = true;
    }
  } catch (err) {
    console.error('D1 insert failed:', err.message);
  }

  // ---- 2. KV, always, so nothing is ever only in one place ---------------
  try {
    if (env.IDEAS_KV) {
      await env.IDEAS_KV.put(
        `reportlead:${Date.now()}-${crypto.randomUUID()}`,
        JSON.stringify(row)
      );
      saved = true;
    }
  } catch (err) {
    console.error('KV save failed:', err.message);
  }

  // ---- 3. Email, best effort only ---------------------------------------
  const to = env.CONTACT_TO || FALLBACK_TO;
  const from = env.FROM_ADDRESS || DEFAULT_FROM;
  const text =
    `Someone downloaded the free report from studiovelox.com\n\n` +
    `Name:     ${name}\n` +
    `Email:    ${email}\n` +
    `Suburb:   ${suburb || '(unknown)'}\n` +
    `Came from: ${referrer || '(direct)'}\n` +
    `Received: ${when}\n\n` +
    `They have the PDF already — it downloaded in their browser.\n` +
    `A follow-up in a day or two is warm, not cold: they asked for this.\n`;

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
            subject: `Report download — ${name}`,
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
        body: JSON.stringify({
          from: `Studio Velox <${from}>`, to: [to],
          subject: `Report download — ${name}`, text,
        }),
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
    endpoint: '/api/reportlead',
    usage: 'POST { name, email, page? }',
    note: 'The PDF is delivered by the page, not by this endpoint.',
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204 });
}
