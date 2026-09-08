export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  // POST — run a search for a category + suburb
  if (request.method === 'POST') {
    const { category, suburb } = await request.json();
    if (!category || !suburb) {
      return new Response(JSON.stringify({ error: 'category and suburb required' }), { status: 400, headers });
    }

    const apiKey = env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'GOOGLE_PLACES_API_KEY not configured' }), { status: 500, headers });
    }

    const query = `${category} in ${suburb}`;
    const TEXT_SEARCH = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
    const DETAILS    = 'https://maps.googleapis.com/maps/api/place/details/json';

    // Fetch all pages from Places Text Search
    let places = [];
    let params = new URLSearchParams({ query, key: apiKey });
    let pageCount = 0;

    while (pageCount < 3) {
      const res  = await fetch(`${TEXT_SEARCH}?${params}`);
      const data = await res.json();
      if (!['OK','ZERO_RESULTS'].includes(data.status)) break;
      places.push(...(data.results || []));
      if (!data.next_page_token) break;
      // Wait for next_page_token to become valid
      await new Promise(r => setTimeout(r, 2000));
      params = new URLSearchParams({ pagetoken: data.next_page_token, key: apiKey });
      pageCount++;
    }

    // Fetch details and write to D1
    let inserted = 0, skipped = 0;
    const results = [];

    for (const place of places) {
      // Get phone and website from Place Details
      const detRes  = await fetch(`${DETAILS}?${new URLSearchParams({ place_id: place.place_id, fields: 'name,formatted_phone_number,website,formatted_address', key: apiKey })}`);
      const detData = await detRes.json();
      const det     = detData.result || {};

      const name        = det.name        || place.name || '';
      const address     = det.formatted_address || place.formatted_address || '';
      const phone       = det.formatted_phone_number || '';
      const website     = det.website || '';
      const has_website = website ? 1 : 0;

      // Auto-score: hot = no website, warm = social only, cool = has real site
      let score = 'cool';
      let score_reason = 'Has a website';
      if (!website) {
        score = 'hot';
        score_reason = 'No website found';
      } else if (website.includes('facebook.com') || website.includes('instagram.com')) {
        score = 'warm';
        score_reason = 'Social media only — no real website';
      }

      // Skip if already in DB (same name + suburb)
      const existing = await env.VELOX_DB.prepare(
        'SELECT id FROM leads WHERE name = ? AND suburb = ?'
      ).bind(name, suburb).first();

      if (existing) { skipped++; continue; }

      await env.VELOX_DB.prepare(
        `INSERT INTO leads (name, category, suburb, address, phone, website, has_website, score, score_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(name, category, suburb, address, phone, website, has_website, score, score_reason).run();

      results.push({ name, category, suburb, address, phone, website, has_website, score, score_reason });
      inserted++;

      // Be polite with rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    return new Response(JSON.stringify({
      ok: true,
      query,
      total: places.length,
      inserted,
      skipped,
      results
    }), { headers });
  }

  return new Response('Method not allowed', { status: 405, headers });
}
