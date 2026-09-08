export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  // GET — fetch all leads with optional filters
  if (request.method === 'GET') {
    const url    = new URL(request.url);
    const score  = url.searchParams.get('score');
    const status = url.searchParams.get('status');
    const suburb = url.searchParams.get('suburb');
    const search = url.searchParams.get('search');

    let query  = 'SELECT * FROM leads WHERE 1=1';
    const vals = [];

    if (score)  { query += ' AND score = ?';           vals.push(score); }
    if (status) { query += ' AND status = ?';           vals.push(status); }
    if (suburb) { query += ' AND suburb LIKE ?';        vals.push(`%${suburb}%`); }
    if (search) { query += ' AND (name LIKE ? OR address LIKE ?)'; vals.push(`%${search}%`, `%${search}%`); }

    query += ' ORDER BY CASE score WHEN \'hot\' THEN 1 WHEN \'warm\' THEN 2 ELSE 3 END, date_found DESC';

    const stmt   = env.VELOX_DB.prepare(query);
    const result = await stmt.bind(...vals).all();

    return new Response(JSON.stringify(result.results || []), { headers });
  }

  // PATCH — update a lead's status or notes
  if (request.method === 'PATCH') {
    const body = await request.json();
    const { id, status, notes } = body;
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });

    if (status !== undefined && notes !== undefined) {
      await env.VELOX_DB.prepare('UPDATE leads SET status = ?, notes = ? WHERE id = ?').bind(status, notes, id).run();
    } else if (status !== undefined) {
      await env.VELOX_DB.prepare('UPDATE leads SET status = ? WHERE id = ?').bind(status, id).run();
    } else if (notes !== undefined) {
      await env.VELOX_DB.prepare('UPDATE leads SET notes = ? WHERE id = ?').bind(notes, id).run();
    }

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
