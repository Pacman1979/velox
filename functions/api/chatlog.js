/**
 * POST /api/chatlog  —  one question, and whether the assistant knew it
 * ---------------------------------------------------------------------------
 * Public, keyless, and deliberately tiny. This is what the $147 tier sells:
 * at the end of the month the client gets the list of things their customers
 * asked that the assistant could not answer.
 *
 * What it stores: the question, which answer it matched, and whether it
 * matched at all.
 *
 * What it does NOT store, on purpose: no IP, no session id, no cookie, no
 * name, no contact details, nothing that joins two questions to one person.
 * The widget never sends a name or a phone number here either — those go to
 * /api/chatlead, which a person has to actively choose.
 *
 * Abuse control is the same shape as /api/chatlead: a per-IP hourly cap held
 * in KV. The IP is used for that counter and then thrown away — it is never
 * written to the database.
 */

const MAX_PER_HOUR = 120;   // a real conversation is ~10; this stops a flood
const MAX_Q = 300;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false });
  }

  const question = String(body.question || '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q);
  if (!question) return json({ ok: false });

  const topic = String(body.topic || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || null;
  const answered = body.answered ? 1 : 0;
  const page = String(body.page || '').slice(0, 120);

  // Which assistant this was. Falls back to the hostname that called us, so a
  // widget that forgets to set it still lands somewhere sensible.
  let site = String(body.site || '').replace(/\s+/g, '').slice(0, 120);
  if (!site) {
    try { site = new URL(request.headers.get('Referer') || '').hostname; } catch { site = 'unknown'; }
  }

  // ---- rate limit; the IP is used here and nowhere else ------------------
  if (env.IDEAS_KV) {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const key = `chatlog:rate:${ip}:${new Date().toISOString().slice(0, 13)}`;
      const seen = Number((await env.IDEAS_KV.get(key)) || 0);
      if (seen >= MAX_PER_HOUR) return json({ ok: false });
      await env.IDEAS_KV.put(key, String(seen + 1), { expirationTtl: 7200 });
    } catch (err) {
      console.error('chatlog rate limit failed:', err.message);
    }
  }

  try {
    if (env.VELOX_DB) {
      await env.VELOX_DB.prepare(
        `INSERT INTO chat_questions (site, question, topic, answered, page, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      ).bind(site, question, topic, answered, page).run();
    }
  } catch (err) {
    // A log that fails must never break the conversation it came from.
    console.error('chatlog insert failed:', err.message);
  }

  return json({ ok: true });
}

export function onRequestGet() {
  return json({
    ok: false,
    endpoint: '/api/chatlog',
    usage: 'POST { question, topic?, answered?, site?, page? }',
    stores: 'the question only — no IP, no session, nothing identifying',
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204 });
}
