export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  if (request.method === 'POST') {
    const body = await request.json();

    // Bulk CSV import
    if (body.bulk && Array.isArray(body.leads)) {
      let inserted = 0, skipped = 0;
      for (const lead of body.leads) {
        const { name, category, suburb, address, phone, website, referral_source, notes } = lead;
        if (!name) continue;
        const existing = await env.VELOX_DB.prepare(
          'SELECT id FROM leads WHERE name = ? AND suburb = ?'
        ).bind(name, suburb||'').first();
        if (existing) { skipped++; continue; }

        const has_website = website ? 1 : 0;
        let score = 'cool', score_reason = 'Has a website';
        if (!website) { score = 'hot'; score_reason = 'No website found'; }
        else if (website.includes('facebook.com') || website.includes('instagram.com')) {
          score = 'warm'; score_reason = 'Social media only — no real website';
        }

        await env.VELOX_DB.prepare(
          `INSERT INTO leads (name, category, suburb, address, phone, website, has_website, score, score_reason, referral_source, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(name, category||'', suburb||'', address||'', phone||'', website||'', has_website, score, score_reason, referral_source||'csv_import', notes||'').run();
        inserted++;
      }
      return new Response(JSON.stringify({ ok: true, inserted, skipped }), { headers });
    }

    // Google Places search
    const { category, suburb } = body;
    if (!category || !suburb) {
      return new Response(JSON.stringify({ error: 'category and suburb required' }), { status: 400, headers });
    }

    const apiKey = env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'GOOGLE_PLACES_API_KEY not configured' }), { status: 500, headers });
    }

    const query = `${category} in ${suburb}`;
    const TEXT_SEARCH = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
    const DETAILS     = 'https://maps.googleapis.com/maps/api/place/details/json';

    let places = [], pageCount = 0;
    let params = new URLSearchParams({ query, key: apiKey });

    while (pageCount < 3) {
      const res  = await fetch(`${TEXT_SEARCH}?${params}`);
      const data = await res.json();
      if (!['OK','ZERO_RESULTS'].includes(data.status)) break;
      places.push(...(data.results || []));
      if (!data.next_page_token) break;
      await new Promise(r => setTimeout(r, 2000));
      params = new URLSearchParams({ pagetoken: data.next_page_token, key: apiKey });
      pageCount++;
    }

    let inserted = 0, skipped = 0;
    const results = [];

    for (const place of places) {
      const detRes  = await fetch(`${DETAILS}?${new URLSearchParams({ place_id: place.place_id, fields: 'name,formatted_phone_number,website,formatted_address', key: apiKey })}`);
      const det     = (await detRes.json()).result || {};

      const name        = det.name || place.name || '';
      const address     = det.formatted_address || place.formatted_address || '';
      const phone       = det.formatted_phone_number || '';
      const website     = det.website || '';
      const has_website = website ? 1 : 0;

      let score = 'cool', score_reason = 'Has a website';
      if (!website) { score = 'hot'; score_reason = 'No website found'; }
      else if (website.includes('facebook.com') || website.includes('instagram.com')) {
        score = 'warm'; score_reason = 'Social media only — no real website';
      }

      const existing = await env.VELOX_DB.prepare(
        'SELECT id FROM leads WHERE name = ? AND suburb = ?'
      ).bind(name, suburb).first();
      if (existing) { skipped++; continue; }

      await env.VELOX_DB.prepare(
        `INSERT INTO leads (name, category, suburb, address, phone, website, has_website, score, score_reason, referral_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(name, category, suburb, address, phone, website, has_website, score, score_reason, 'google_places').run();

      results.push({ name, score });
      inserted++;
      await new Promise(r => setTimeout(r, 200));
    }

    return new Response(JSON.stringify({ ok: true, query, total: places.length, inserted, skipped, results }), { headers });
  }

  return new Response('Method not allowed', { status: 405, headers });
}
