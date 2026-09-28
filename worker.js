/**
 * velox-cron — the scheduler
 *
 * This is the whole Worker. It exists for one reason: Cloudflare Pages cannot
 * run scheduled jobs, so something outside Pages has to do the waking up.
 * It holds no logic of its own. It wakes on the cron, calls your Pages
 * endpoint, logs what came back, and goes back to sleep.
 *
 * Deployed separately from the velox Pages project. Nothing in velox changes.
 */

const ENDPOINT = 'https://studiovelox.com/api/cron-search';

export default {
  /** Fired by the Cron Trigger. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, 'cron'));
  },

  /**
   * Visit the Worker's URL with ?key=YOUR_VELOX_API_KEY to run it by hand.
   * Useful on the first Sunday, when you want to see it work rather than
   * trust that it did.
   */
  async fetch(request, env) {
    const key = new URL(request.url).searchParams.get('key');
    if (key !== env.VELOX_API_KEY) {
      return new Response('Nope.', { status: 403 });
    }
    const result = await run(env, 'manual');
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

async function run(env, trigger) {
  const searches = Number(env.SEARCHES_PER_RUN || 5);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Velox-Key': env.VELOX_API_KEY,
      },
      body: JSON.stringify({ searches, trigger }),
    });

    const text = await res.text();
    console.log(`[velox-cron] ${trigger} → ${res.status}`, text.slice(0, 1000));

    try {
      return { ok: res.ok, status: res.status, result: JSON.parse(text) };
    } catch {
      return { ok: res.ok, status: res.status, body: text.slice(0, 1000) };
    }
  } catch (err) {
    console.error('[velox-cron] failed:', err);
    return { ok: false, error: String(err?.message || err) };
  }
}
