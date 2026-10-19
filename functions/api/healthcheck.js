/**
 * POST /api/healthcheck  —  the monthly report that care plans are sold on
 * ---------------------------------------------------------------------------
 * Requires the X-Velox-Key header. Woken by velox-cron on the 2nd of each
 * month; can be run by hand any time to see what would go out.
 *
 * For every active care client, in tier order:
 *
 *   tier 1 ($47)   nothing. The $47 plan does not promise a report, so it
 *                  does not get one. Promising less and delivering it is the
 *                  whole business model.
 *   tier 2 ($97)   the real audit from /api/quickaudit, plus visitor numbers
 *                  from Cloudflare Web Analytics where a site tag is set.
 *   tier 3 ($147)  all of that, plus what their customers asked the assistant
 *                  — and in particular what it could not answer.
 *
 * Two things make a re-run safe:
 *   1. health_reports has UNIQUE (client_id, period), so a second run in the
 *      same month inserts nothing and sends nothing.
 *   2. ?dry=1 builds every report and sends none, so Phil can read them first.
 *
 * Budget: Cloudflare allows 50 subrequests per invocation. Each client costs
 * up to 3 (audit, analytics, email), so MAX_CLIENTS is set well under that
 * and the rest wait for the next run.
 */

import { requireKey } from './auth.js';

const MAX_CLIENTS = 12;
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const DEFAULT_FROM = 'reports@studiovelox.com';
const FROM_NAME = 'Studio Velox';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ─────────────────────────────────────────────────────────────── dates ──
 * The report covers the previous calendar month, so running it on the 2nd
 * of November reports on October. Brisbane is UTC+10 all year.
 */
function lastMonth(now = new Date()) {
  const bris = new Date(now.getTime() + 10 * 3600 * 1000);
  const y = bris.getUTCFullYear();
  const m = bris.getUTCMonth();              // 0-11, this month
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const period = start.toISOString().slice(0, 7);
  const label = start.toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { period, label, fromISO: start.toISOString(), toISO: end.toISOString() };
}

/* ───────────────────────────────────────────────────────────── analytics ──
 * Cloudflare Web Analytics, via the GraphQL API. Two things to know:
 *   - a failed query comes back as HTTP 200 with an `errors` array, so the
 *     status code alone tells you nothing;
 *   - `sum { visits }` is not in every account's schema. So we ask for the
 *     richer shape first and fall back to plain counts if the server says
 *     that field doesn't exist, rather than losing the whole report over it.
 */
async function analytics(env, siteTag, fromISO, toISO) {
  if (!siteTag) return { ok: false, why: 'no site tag set for this client' };
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    return { ok: false, why: 'CF_ANALYTICS_TOKEN or CF_ACCOUNT_ID not set' };
  }

  const build = (withVisits) => `
    query {
      viewer {
        accounts(filter: { accountTag: "${env.CF_ACCOUNT_ID}" }) {
          rumPageloadEventsAdaptiveGroups(
            limit: 100
            orderBy: [count_DESC]
            filter: {
              siteTag: "${siteTag}"
              datetime_geq: "${fromISO}"
              datetime_leq: "${toISO}"
            }
          ) {
            count
            ${withVisits ? 'sum { visits }' : ''}
            dimensions { refererHost }
          }
        }
      }
    }`;

  async function ask(withVisits) {
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: build(withVisits) }),
    });
    const payload = await res.json().catch(() => null);
    return { res, payload };
  }

  try {
    let withVisits = true;
    let { res, payload } = await ask(true);

    const errText = payload && payload.errors
      ? payload.errors.map((e) => e.message || '').join('; ')
      : '';
    if (errText && /visits/i.test(errText)) {
      withVisits = false;
      ({ res, payload } = await ask(false));
    }

    if (!res.ok) return { ok: false, why: `analytics returned HTTP ${res.status}` };
    if (payload && payload.errors && payload.errors.length) {
      return { ok: false, why: payload.errors.map((e) => e.message).join('; ').slice(0, 200) };
    }

    const groups =
      payload?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];

    let views = 0;
    let visits = 0;
    const referrers = [];
    for (const g of groups) {
      views += g.count || 0;
      if (withVisits) visits += g.sum?.visits || 0;
      const host = g.dimensions?.refererHost;
      if (host && host !== 'none' && host !== '') referrers.push([host, g.count || 0]);
    }
    referrers.sort((a, b) => b[1] - a[1]);

    return {
      ok: true,
      views,
      visits: withVisits ? visits : null,
      referrers: referrers.slice(0, 5),
      capped: groups.length >= 100,
    };
  } catch (err) {
    return { ok: false, why: String(err?.message || err).slice(0, 200) };
  }
}

/* ────────────────────────────────────────────────────────────── the email ──
 * Plain text and HTML, both built from the same pieces. Written to be read
 * by a plumber on a phone, not by a marketer on a dashboard.
 */
function compose(client, label, audit, stats, qs) {
  const lines = [];
  const html = [];
  const h = (s) => html.push(s);

  lines.push(`Your website in ${label}`);
  lines.push('='.repeat(40), '');
  h(`<h2 style="font:600 20px/1.3 system-ui,sans-serif;color:#0a1628;margin:0 0 4px">Your website in ${esc(label)}</h2>`);
  h(`<p style="font:14px/1.6 system-ui,sans-serif;color:#6b7280;margin:0 0 22px">${esc(client.site_url)}</p>`);

  // ── the audit ──
  if (audit && audit.ok) {
    lines.push(audit.headline, '');
    h(`<p style="font:600 16px/1.5 system-ui,sans-serif;color:#0a1628;margin:0 0 6px">${esc(audit.headline)}</p>`);

    const bad = audit.findings || [];
    const watch = audit.worth_a_look || [];
    if (bad.length || watch.length) {
      h('<ul style="font:14px/1.6 system-ui,sans-serif;color:#0a1628;padding-left:18px;margin:0 0 18px">');
      for (const f of bad.concat(watch)) {
        lines.push(`  - ${f.title}`);
        if (f.detail) lines.push(`    ${f.detail}`);
        h(`<li style="margin-bottom:7px"><strong>${esc(f.title)}</strong>`
          + (f.detail ? `<br><span style="color:#6b7280">${esc(f.detail)}</span>` : '') + '</li>');
      }
      h('</ul>');
      lines.push('');
    }
    const good = audit.counts?.good || 0;
    if (good) {
      lines.push(`${good} things on it are working as they should.`, '');
      h(`<p style="font:14px/1.6 system-ui,sans-serif;color:#6b7280;margin:0 0 22px">${good} things on it are working as they should.</p>`);
    }
  } else {
    const why = (audit && audit.headline) || "I couldn't reach the site when I ran this.";
    lines.push(why, '');
    h(`<p style="font:14px/1.6 system-ui,sans-serif;color:#b45309;margin:0 0 22px">${esc(why)}</p>`);
  }

  // ── visitors ──
  if (stats && stats.ok) {
    const v = stats.visits == null
      ? `${stats.views} page views`
      : `${stats.views} page views from ${stats.visits} visits`;
    lines.push('Visitors', '-'.repeat(20), v);
    h('<h3 style="font:600 15px/1.4 system-ui,sans-serif;color:#0a1628;margin:0 0 6px">Visitors</h3>');
    h(`<p style="font:14px/1.6 system-ui,sans-serif;color:#0a1628;margin:0 0 6px">${esc(v)}.</p>`);
    if (stats.referrers.length) {
      lines.push('Mostly arriving from:');
      h('<p style="font:14px/1.6 system-ui,sans-serif;color:#6b7280;margin:0 0 22px">Mostly arriving from: '
        + stats.referrers.map(([hst, n]) => `${esc(hst)} (${n})`).join(', ') + '</p>');
      for (const [hst, n] of stats.referrers) lines.push(`  ${hst} — ${n}`);
    } else {
      h('<p style="font:14px/1.6 system-ui,sans-serif;color:#6b7280;margin:0 0 22px">Nearly all of them typed your address in or came from a search.</p>');
      lines.push('Nearly all of them typed your address in or came from a search.');
    }
    lines.push('');
  } else if (client.tier >= 2) {
    const why = `Visitor numbers aren't connected for this site yet (${stats?.why || 'not configured'}).`;
    lines.push(why, '');
    h(`<p style="font:14px/1.6 system-ui,sans-serif;color:#b45309;margin:0 0 22px">${esc(why)}</p>`);
  }

  // ── what people asked ──
  if (client.tier >= 3 && qs) {
    lines.push('What your customers asked', '-'.repeat(25));
    h('<h3 style="font:600 15px/1.4 system-ui,sans-serif;color:#0a1628;margin:0 0 6px">What your customers asked</h3>');
    if (!qs.total) {
      lines.push('Nobody used the assistant this month.', '');
      h('<p style="font:14px/1.6 system-ui,sans-serif;color:#6b7280;margin:0 0 22px">Nobody used the assistant this month.</p>');
    } else {
      const s = `${qs.total} questions, and it answered ${qs.total - qs.unanswered.length}.`;
      lines.push(s);
      h(`<p style="font:14px/1.6 system-ui,sans-serif;color:#0a1628;margin:0 0 10px">${esc(s)}</p>`);
      if (qs.unanswered.length) {
        lines.push('', "These it could NOT answer — worth a look:");
        h('<p style="font:600 14px/1.6 system-ui,sans-serif;color:#0a1628;margin:0 0 6px">These it could not answer:</p>');
        h('<ul style="font:14px/1.6 system-ui,sans-serif;color:#0a1628;padding-left:18px;margin:0 0 10px">');
        for (const q of qs.unanswered) {
          lines.push(`  "${q}"`);
          h(`<li style="margin-bottom:5px">&ldquo;${esc(q)}&rdquo;</li>`);
        }
        h('</ul>');
        h('<p style="font:14px/1.6 system-ui,sans-serif;color:#6b7280;margin:0 0 22px">Tell me the answers and I will teach it, no charge — it is part of your plan.</p>');
        lines.push('', 'Tell me the answers and I will teach it, no charge.');
      }
      lines.push('');
    }
  }

  lines.push('', '--', 'Phil Campbell · Studio Velox', '0422 777 865 · phil@studiovelox.com');
  h('<hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0 14px">');
  h('<p style="font:13px/1.6 system-ui,sans-serif;color:#6b7280;margin:0">Phil Campbell &middot; Studio Velox<br>'
    + '<a href="tel:+61422777865" style="color:#9a6a00">0422 777 865</a> &middot; '
    + '<a href="mailto:phil@studiovelox.com" style="color:#9a6a00">phil@studiovelox.com</a></p>');

  return {
    text: lines.join('\n'),
    html: `<div style="max-width:620px;margin:0 auto;padding:8px">${html.join('')}</div>`,
  };
}

/* ───────────────────────────────────────────────────────────────── send ──
 * Same sender detection as /api/contact. Returns true only if a send was
 * actually accepted, so health_reports.sent never claims something untrue.
 */
async function send(env, to, subject, body) {
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
            from: `${FROM_NAME} <${from}>`,
            to,
            reply_to: 'phil@studiovelox.com',
            subject,
            text: body.text,
            html: body.html,
          }),
        }
      );
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload || payload.success !== true) {
        const why = payload?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
        return { sent: false, why };
      }
      return { sent: true };
    }

    if (env.RESEND_API_KEY) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${FROM_NAME} <${from}>`,
          to: [to],
          reply_to: 'phil@studiovelox.com',
          subject,
          text: body.text,
          html: body.html,
        }),
      });
      if (!res.ok) return { sent: false, why: `Resend returned ${res.status}` };
      return { sent: true };
    }

    return { sent: false, why: 'no email sender configured' };
  } catch (err) {
    return { sent: false, why: String(err?.message || err).slice(0, 200) };
  }
}

/* ────────────────────────────────────────────────────────────────── main ──*/

export async function onRequestPost({ request, env }) {
  const denied = requireKey(request, env);
  if (denied) return denied;

  const db = env.VELOX_DB;
  if (!db) return json({ ok: false, error: 'VELOX_DB binding missing' }, 500);

  const url = new URL(request.url);
  let body = {};
  try { body = await request.json(); } catch { /* a bare POST is fine */ }

  const dry = url.searchParams.get('dry') === '1' || body.dry === true;
  const only = body.client_id ? Number(body.client_id) : null;
  const { period, label, fromISO, toISO } = lastMonth();

  // Tier 1 is excluded in SQL rather than skipped in code — the $47 plan does
  // not promise a report, so it should never even be considered for one.
  let sql =
    `SELECT c.* FROM care_clients c
      WHERE c.active = 1 AND c.tier >= 2
        AND NOT EXISTS (
          SELECT 1 FROM health_reports r
           WHERE r.client_id = c.id AND r.period = ? AND r.sent = 1
        )`;
  const binds = [period];
  if (only) { sql += ' AND c.id = ?'; binds.push(only); }
  sql += ' ORDER BY c.tier DESC, c.id ASC LIMIT ?';
  binds.push(MAX_CLIENTS);

  let clients;
  try {
    clients = (await db.prepare(sql).bind(...binds).all()).results || [];
  } catch (err) {
    return json({ ok: false, error: `could not read care_clients: ${err.message}` }, 500);
  }

  const done = [];

  for (const c of clients) {
    // 1. the audit — the same endpoint prospects get
    let audit = null;
    try {
      const res = await fetch(new URL('/api/quickaudit', url.origin).href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: c.site_url }),
      });
      audit = await res.json();
    } catch (err) {
      audit = { ok: false, headline: `Could not reach ${c.site_url}.`, _err: err.message };
    }

    // 2. visitors, for tier 2 and up
    const stats = await analytics(env, c.cf_site_tag, fromISO, toISO);

    // 3. what people asked, for tier 3
    let qs = null;
    if (c.tier >= 3) {
      const key = c.assistant_key || c.site_url;
      try {
        const totalRow = await db.prepare(
          `SELECT COUNT(*) AS n FROM chat_questions
            WHERE site = ? AND created_at >= ? AND created_at < ?`
        ).bind(key, fromISO.slice(0, 19).replace('T', ' '), toISO.slice(0, 19).replace('T', ' ')).first();

        const missed = await db.prepare(
          `SELECT question FROM chat_questions
            WHERE site = ? AND answered = 0
              AND created_at >= ? AND created_at < ?
            ORDER BY created_at DESC LIMIT 15`
        ).bind(key, fromISO.slice(0, 19).replace('T', ' '), toISO.slice(0, 19).replace('T', ' ')).all();

        qs = {
          total: totalRow?.n || 0,
          unanswered: (missed.results || []).map((r) => r.question),
        };
      } catch (err) {
        qs = { total: 0, unanswered: [], _err: err.message };
      }
    }

    const mail = compose(c, label, audit, stats, qs);
    const subject = `Your website in ${label} — ${c.name}`;

    let sent = false;
    let why = 'dry run';
    if (!dry) {
      const r = await send(env, c.contact_email, subject, mail);
      sent = r.sent;
      why = r.why || 'sent';
    }

    // Record it either way, so a dry run still shows what the month looked
    // like — but only a real send sets sent = 1.
    if (!dry) {
      try {
        await db.prepare(
          `INSERT INTO health_reports
             (client_id, period, costing, watch, good, pageviews, questions, unanswered, sent, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (client_id, period) DO UPDATE SET
             sent = MAX(health_reports.sent, excluded.sent),
             detail = excluded.detail`
        ).bind(
          c.id, period,
          audit?.counts?.costing ?? 0,
          audit?.counts?.watch ?? 0,
          audit?.counts?.good ?? 0,
          stats.ok ? stats.views : null,
          qs ? qs.total : null,
          qs ? qs.unanswered.length : null,
          sent ? 1 : 0,
          mail.text.slice(0, 20000)
        ).run();
      } catch (err) {
        why += ` (but the row did not save: ${err.message})`;
      }
    }

    done.push({
      client: c.name,
      tier: c.tier,
      site: c.site_url,
      audit: audit?.ok ? audit.headline : `not reached — ${audit?.headline || 'unknown'}`,
      visitors: stats.ok ? stats.views : `unavailable — ${stats.why}`,
      questions: qs ? `${qs.total} asked, ${qs.unanswered.length} unanswered` : null,
      sent,
      why,
      preview: dry ? mail.text : undefined,
    });
  }

  return json({
    ok: true,
    period,
    label,
    dry,
    considered: clients.length,
    capped_at: MAX_CLIENTS,
    reports: done,
  });
}

/** A GET explains itself rather than throwing. */
export function onRequestGet() {
  return json({
    ok: false,
    endpoint: '/api/healthcheck',
    usage: 'POST with X-Velox-Key. Add ?dry=1 to build every report and send none.',
    note: 'Reports on the previous calendar month. Tier 1 clients are never included.',
  });
}
