/**
 * POST /api/contact  —  The Breath Therapy contact form
 *
 * Two-stage safety net:
 *   1. Every enquiry is written to KV first, so nothing can ever be silently lost.
 *   2. Then we try to email Taylor.
 *
 * If the email fails, the enquiry is still saved and the visitor is told
 * honestly, with Taylor's address as a fallback. We never show a tick we
 * haven't earned.
 *
 * Sender is auto-detected in priority order, so this file works unchanged:
 *   1. CF_ACCOUNT_ID + CF_EMAIL_TOKEN  -> Cloudflare Email Service REST API
 *   2. env.EMAIL / env.SEND_EMAIL      -> Cloudflare Workers binding (if ever migrated)
 *   3. RESEND_API_KEY                  -> Resend HTTP API
 *
 * NOTE: this repo is public. Never hardcode secrets or personal addresses
 * here. Set them as encrypted secrets under
 * Workers & Pages -> taylor -> Settings -> Variables and Secrets.
 */

const DEFAULT_FROM = 'website@thebreaththerapy.com.au';
const DEFAULT_FROM_NAME = 'Website Enquiry';
const FALLBACK_TO = 'taylor@thebreaththerapy.com.au';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Brisbane time (AEST, UTC+10, no daylight saving)
function brisbaneNow() {
  return new Date(Date.now() + 10 * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 16) + ' AEST';
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request' }, 400);
  }

  // Honeypot -- real people never fill this in, bots usually do.
  if (body.website) return json({ ok: true });

  const firstName = (body.firstName || '').trim().slice(0, 100);
  const lastName  = (body.lastName  || '').trim().slice(0, 100);
  const email     = (body.email     || '').trim().slice(0, 200);
  const session   = (body.session   || 'Not specified').trim().slice(0, 200);
  const message   = (body.message   || '').trim().slice(0, 5000);

  if (!firstName) return json({ ok: false, error: 'Please enter your first name.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const when = brisbaneNow();

  // ---- 1. Save to KV first, so the enquiry survives an email failure ----
  let saved = false;
  try {
    if (env.IDEAS_KV) {
      await env.IDEAS_KV.put(
        `contact:${Date.now()}-${crypto.randomUUID()}`,
        JSON.stringify({ firstName, lastName, email, session, message, when })
      );
      saved = true;
    }
  } catch (err) {
    console.error('KV save failed:', err.message);
  }

  // ---- 2. Build the notification ----
  const toAddress   = env.CONTACT_TO   || FALLBACK_TO;
  const fromAddress = env.FROM_ADDRESS || DEFAULT_FROM;
  const fromName    = env.FROM_NAME    || DEFAULT_FROM_NAME;
  const subject = `New website enquiry from ${fullName}`;

  const text =
    `New enquiry from thebreaththerapy.com.au\n\n` +
    `Name:     ${fullName}\n` +
    `Email:    ${email}\n` +
    `Session:  ${session}\n` +
    `Received: ${when}\n\n` +
    `Message:\n${message || '(no message)'}\n\n` +
    `Just hit reply to respond to ${firstName} directly.`;

  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;color:#2c2825">
      <h2 style="font-weight:400;color:#c9a097;margin-bottom:1.5rem">New website enquiry</h2>
      <p style="margin:0 0 .4rem"><strong>Name:</strong> ${esc(fullName)}</p>
      <p style="margin:0 0 .4rem"><strong>Email:</strong> <a href="mailto:${esc(email)}">${esc(email)}</a></p>
      <p style="margin:0 0 .4rem"><strong>Session:</strong> ${esc(session)}</p>
      <p style="margin:0 0 1.5rem"><strong>Received:</strong> ${esc(when)}</p>
      <div style="border-left:3px solid #e8d5cc;padding-left:1rem;white-space:pre-wrap">${esc(message) || '<em>(no message)</em>'}</div>
      <p style="margin-top:1.5rem;color:#8a817c;font-size:.9rem">Just hit reply to respond to ${esc(firstName)} directly.</p>
    </div>`;

  // ---- 3. Send ----
  let sent = false;

  try {
    if (env.CF_ACCOUNT_ID && env.CF_EMAIL_TOKEN) {
      // Cloudflare Email Service REST API -- no Workers binding required.
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.CF_EMAIL_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${fromName} <${fromAddress}>`,
            to: toAddress,
            reply_to: email,   // REST uses reply_to; the Workers binding uses replyTo
            subject,
            text,
            html,
          }),
        }
      );

      // The Cloudflare API can return HTTP 200 with success:false, so check both.
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload || payload.success !== true) {
        const detail = (payload && payload.errors)
          ? payload.errors.map(e => `${e.code}: ${e.message}`).join('; ')
          : `HTTP ${res.status}`;
        throw new Error(`Cloudflare send failed -- ${detail}`);
      }
      sent = true;

    } else if (env.EMAIL && typeof env.EMAIL.send === 'function') {
      // Workers binding, if this ever moves off Pages.
      await env.EMAIL.send({
        from: `${fromName} <${fromAddress}>`,
        to: toAddress,
        replyTo: email,
        subject, text, html,
      });
      sent = true;

    } else if (env.RESEND_API_KEY) {
      // Resend fallback.
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${fromName} <${fromAddress}>`,
          to: [toAddress],
          reply_to: email,
          subject, text, html,
        }),
      });
      if (!res.ok) throw new Error(`Resend returned ${res.status}: ${await res.text()}`);
      sent = true;

    } else {
      throw new Error('No email sender configured');
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
  }

  if (sent) return json({ ok: true });

  // Honest failure -- the visitor is told, and we still have their enquiry.
  return json({ ok: false, saved, error: 'Could not send message' }, 502);
}
