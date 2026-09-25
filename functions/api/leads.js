export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  // GET — fetch all leads
  if (request.method === 'GET') {
    const url    = new URL(request.url);
    const score  = url.searchParams.get('score');
    const status = url.searchParams.get('status');
    const suburb = url.searchParams.get('suburb');
    const search = url.searchParams.get('search');

    let query  = 'SELECT * FROM leads WHERE 1=1';
    const vals = [];
    if (score)  { query += ' AND score = ?';                       vals.push(score); }
    if (status) { query += ' AND status = ?';                      vals.push(status); }
    if (suburb) { query += ' AND suburb LIKE ?';                   vals.push(`%${suburb}%`); }
    if (search) { query += ' AND (name LIKE ? OR address LIKE ?)'; vals.push(`%${search}%`, `%${search}%`); }
    query += " ORDER BY CASE score WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 ELSE 3 END, date_found DESC";

    const result = await env.VELOX_DB.prepare(query).bind(...vals).all();
    return new Response(JSON.stringify(result.results || []), { headers });
  }

  // POST — manually add a single lead
  if (request.method === 'POST') {
    const body = await request.json();
    const { name, category, suburb, address, phone, website, referral_source, notes } = body;
    if (!name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers });

    const has_website = website ? 1 : 0;
    let score = 'cool', score_reason = 'Has a website';
    if (!website) { score = 'hot'; score_reason = 'No website found'; }
    else if (website.includes('facebook.com') || website.includes('instagram.com')) {
      score = 'warm'; score_reason = 'Social media only — no real website';
    }

    const existing = await env.VELOX_DB.prepare(
      'SELECT id FROM leads WHERE name = ? AND suburb = ?'
    ).bind(name, suburb || '').first();
    if (existing) return new Response(JSON.stringify({ error: 'Lead already exists', duplicate: true }), { status: 409, headers });

    await env.VELOX_DB.prepare(
      `INSERT INTO leads (name, category, suburb, address, phone, website, has_website, score, score_reason, referral_source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(name, category||'', suburb||'', address||'', phone||'', website||'', has_website, score, score_reason, referral_source||'manual', notes||'').run();

    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  // PATCH — update status, notes, contact info and new date fields
  if (request.method === 'PATCH') {
    const body = await request.json();
    const { id, status, notes, contact_method, date_contacted, follow_up_date } = body;
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });

    await env.VELOX_DB.prepare(
      `UPDATE leads SET
        status = COALESCE(?, status),
        notes = COALESCE(?, notes),
        contact_method = COALESCE(?, contact_method),
        date_contacted = COALESCE(?, date_contacted),
        follow_up_date = COALESCE(?, follow_up_date)
       WHERE id = ?`
    ).bind(
      status ?? null,
      notes ?? null,
      contact_method ?? null,
      date_contacted ?? null,
      follow_up_date ?? null,
      id
    ).run();

    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  // DELETE — remove a lead
  if (request.method === 'DELETE') {
    const { id } = await request.json();
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
    await env.VELOX_DB.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  return new Response('Method not allowed', { status: 405, headers });
}
