/**
 * velox-cron — the scheduler
 *
 * This is the whole Worker. It exists for one reason: Cloudflare Pages cannot
 * run scheduled jobs, so something outside Pages has to do the waking up.
 * It holds no logic of its own. It wakes on a cron, calls the matching Pages
 * endpoint, logs what came back, and goes back to sleep.
 *
 * Three jobs:
 *   "0 19 * * 6"   Sunday 5am AEST   — find new leads        /api/cron-search
 *   every six hours                  — check whether they    /api/verify
 *   (the exact expression is in            have a website
 *    JOBS below, where it is safe
 *    to write a slash-star)
 *   "0 20 1 * *"   2nd of the month, — send care clients     /api/healthcheck
 *                  6am AEST            their monthly report
 *
 * The verifier used to be the manual step: cron-search found businesses and
 * then printed "now go and run /api/verify yourself". Anything that depends
 * on somebody remembering is a step that eventually stops happening, and an
 * unverified lead is useless — /today cannot rank it and scoring cannot see
 * whether it has a website. It costs nothing to automate: verification only
 * fetches candidate domains, with no billed API behind it.
 *
 * Deployed separately from the velox Pages project. Nothing in velox changes.
 */

const SITE = 'https://studiovelox.com';

/** Which cron runs which job. A cron not listed here falls back to the search. */
const JOBS = {
  '0 19 * * 6': 'search',
  '0 */6 * * *': 'verify',
  '0 20 1 * *': 'health',
};

const ENDPOINTS = {
  search: `${SITE}/api/cron-search`,
  verify: `${SITE}/api/verify`,
  health: `${SITE}/api/healthcheck`,
};

/* /api/verify caps itself at 10 leads per call — ten leads times four
   candidate domains is 40 fetches, inside Cloudflare's 50-subrequest limit.
   Four runs a day is 40 leads, which comfortably outpaces what one weekly
   search adds. */
const VERIFY_BATCH = 10;

export default {
  /** Fired by a Cron Trigger. */
  async scheduled(event, env, ctx) {
    const job = JOBS[event.cron] || 'search';
    ctx.waitUntil(run(env, job, 'cron'));
  },

  /**
   * Visit the Worker's URL with ?key=YOUR_VELOX_API_KEY to run it by hand.
   *
   *   ?key=...                 the lead search
   *   ?key=...&job=verify      check the next batch of unverified leads
   *   ?key=...&job=health      send this month's reports
   *   ?key=...&job=health&dry=1    build them and send nothing
   *
   * Useful on the first run of anything, when you want to see it work rather
   * than trust that it did.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (key !== env.VELOX_API_KEY) {
      return new Response('Nope.', { status: 403 });
    }
    const asked = url.searchParams.get('job');
    const job = JOBS[asked] || (ENDPOINTS[asked] ? asked : 'search');
    const dry = url.searchParams.get('dry') === '1';
    const result = await run(env, job, 'manual', dry);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

async function run(env, job, trigger, dry = false) {
  const endpoint = ENDPOINTS[job];
  const body =
      job === 'health' ? { trigger, dry }
    : job === 'verify' ? { limit: VERIFY_BATCH, trigger }
    : { searches: Number(env.SEARCHES_PER_RUN || 5), trigger };

  try {
    const res = await fetch(endpoint + (dry ? '?dry=1' : ''), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Velox-Key': env.VELOX_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    console.log(`[velox-cron] ${job}/${trigger} → ${res.status}`, text.slice(0, 1000));

    try {
      return { ok: res.ok, job, status: res.status, result: JSON.parse(text) };
    } catch {
      return { ok: res.ok, job, status: res.status, body: text.slice(0, 1000) };
    }
  } catch (err) {
    console.error(`[velox-cron] ${job} failed:`, err);
    return { ok: false, job, error: String(err?.message || err) };
  }
}
