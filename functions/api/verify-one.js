/**
 * POST /api/verify-one   { "id": 12 }
 *
 * The CRM's "Check web" button, called from the browser.
 *
 * /api/verify needs the VELOX_API_KEY header, and that key must never be in
 * page source where anyone opening dev tools could read it. So this endpoint
 * sits in between: the browser calls it with no key at all, and it calls
 * /api/verify server-side with the key from env. The key stays on the server.
 *
 * It is behind the same PIN wall as the rest of /crm, and it can only ever
 * verify one lead at a time, so there is nothing here worth abusing.
 */

import { onRequestPost as verify } from './verify.js';

export async function onRequestPost({ request, env }) {
  try {
    const { id } = await request.json();
    if (!id) return json({ error: 'id required' }, 400);
    if (!env.VELOX_API_KEY) return json({ error: 'VELOX_API_KEY is not set on this project' }, 503);

    // Hand verify.js a request that looks exactly like a curl with the key.
    const inner = new Request('https://studiovelox.com/api/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Velox-Key': env.VELOX_API_KEY,
      },
      body: JSON.stringify({ ids: [Number(id)] }),
    });

    return await verify({ request: inner, env });
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
