/**
 * POST /api/ideas-digest  —  "what did my clients ask for yesterday?"
 * ---------------------------------------------------------------------------
 * One email, every morning, listing every client idea that has not been in a
 * digest yet. Then it marks them, so nothing is ever reported twice and
 * nothing is ever missed.
 *
 * Why a digest and not a notification per idea: an alert per change trains
 * you to ignore alerts, which is exactly the state this is meant to fix. One
 * email that says "Taylor added 2, the bakery added 1" gets read.
 *
 * It rides along with the 7am verifier rather than taking a cron trigger of
 * its own — there are five per account and three are spoken for.
 *
 * Needs the API key, like every other cron-facing endpoint:
 *   curl -X POST https://studiovelox.com/api/ideas-digest -H 'X-Velox-Key: ...'
 *
 * `{"dry":true}` builds the email and sends nothing, and marks nothing, so it
 * can be run as often as you like without consuming the queue.
 *
 * Silence is the correct output. If no client added anything, it sends no
 * email at all — a daily "nothing happened" is how a useful alert becomes
 * noise you filter to a folder.
 */

import { requireKey } from './auth.js';

const FALLBACK_TO = 'phil@studiovelox.com';
const DEFAULT_FROM = 'website@studiovelox.com';
const MAX_IDEAS = 200;

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

async function send(env, to, subject, text) {
  const from = env.FROM_ADDRESS || DEFAULT_FROM;
  try {
    if (env.CF_ACCOUNT_ID && env.CF_EMAIL_TOKEN) {
      const res = await fetch(
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
      return { sent: res.ok, why: res.ok ? 'sent' : `HTTP ${res.status}` };
    }
    if (env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: `Studio Velox <${from}>`, to: [to], subject, text }),
      });
      return { sent: res.ok, why: res.ok ? 'sent' : `HTTP ${res.status}` };
    }
  } catch (err) {
    return { sent: false, why: err.message };
  }
  return { sent: false, why: 'no email sender configured' };
}

export async function onRequestPost({ request, env }) {
  const bad = requireKey(request, env);
  if (bad) return bad;

  let body = {};
  try { body = await request.json(); } catch { /* no body is fine */ }
  const url = new URL(request.url);
  const dry = url.searchParams.get('dry') === '1' || body.dry === true;

  const db = env.VELOX_DB;
  if (!db) return json({ ok: false, error: 'No database binding' }, 500);

  let rows;
  try {
    const r = await db.prepare(
      `SELECT i.id, i.body, i.author, i.created_at, c.name AS client, c.id AS client_id
         FROM client_ideas i
         JOIN care_clients c ON c.id = i.client_id
        WHERE i.notified_at IS NULL
        ORDER BY c.name ASC, i.created_at ASC
        LIMIT ?`
    ).bind(MAX_IDEAS).all();
    rows = r.results || [];
  } catch (err) {
    return json({ ok: false, error: `could not read client_ideas: ${err.message}` }, 500);
  }

  /* Silence is the correct output. */
  if (!rows.length) {
    return json({ ok: true, dry, new_ideas: 0, sent: false, why: 'nothing new — no email sent' });
  }

  /* Group by client, because that is how you'd act on it. */
  const byClient = new Map();
  rows.forEach(function (r) {
    if (!byClient.has(r.client)) byClient.set(r.client, []);
    byClient.get(r.client).push(r);
  });

  const lines = [];
  lines.push(rows.length === 1
    ? 'One new idea from a client.'
    : `${rows.length} new ideas from ${byClient.size} client${byClient.size > 1 ? 's' : ''}.`);
  lines.push('');

  byClient.forEach(function (items, client) {
    lines.push(`${client} — ${items.length}`);
    lines.push('-'.repeat(Math.min(client.length + 6, 60)));
    items.forEach(function (i) {
      const who = i.author ? ` (${i.author})` : '';
      lines.push(`  • ${i.body}${who}`);
    });
    lines.push('');
  });

  lines.push('Reply to them in the CRM — they see your answer on their own');
  lines.push('ideas page, which is the point of them writing there.');
  lines.push('');
  lines.push(brisbaneNow());

  const text = lines.join('\n');
  const subject = rows.length === 1
    ? `1 client idea — ${[...byClient.keys()][0]}`
    : `${rows.length} client ideas`;

  if (dry) {
    return json({ ok: true, dry: true, new_ideas: rows.length,
      clients: [...byClient.keys()], sent: false, why: 'dry run', preview: text });
  }

  const to = env.CONTACT_TO || FALLBACK_TO;
  const result = await send(env, to, subject, text);

  /* Only mark them once the email actually went. If sending failed, they stay
     unnotified and tomorrow's digest carries them again — which is the right
     failure: a repeated idea is a nuisance, a silently swallowed one is the
     bug this endpoint exists to prevent. */
  let marked = 0;
  if (result.sent) {
    try {
      const ids = rows.map(function (r) { return r.id; });
      await db.prepare(
        `UPDATE client_ideas SET notified_at = datetime('now')
          WHERE id IN (${ids.map(function(){ return '?'; }).join(',')})`
      ).bind(...ids).run();
      marked = ids.length;
    } catch (err) {
      console.error('could not mark ideas as notified:', err.message);
    }
  }

  return json({
    ok: true, dry: false, new_ideas: rows.length,
    clients: [...byClient.keys()],
    sent: result.sent, why: result.why, marked,
  });
}

export function onRequestGet() {
  return json({
    ok: false,
    endpoint: '/api/ideas-digest',
    usage: 'POST with X-Velox-Key. Add {"dry":true} to build it and send nothing.',
    note: 'Sends no email when there is nothing new.',
  });
}
