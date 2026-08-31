export async function onRequest(context) {
  const { request, env } = context;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers });

  if (request.method === 'GET') {
    const data = await env.IDEAS_KV.get('sv_clients');
    return new Response(data || '[]', { headers });
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    // Bulk save — entire array
    if (body.id === '__ALL__') {
      await env.IDEAS_KV.put('sv_clients', JSON.stringify(body.clients));
      return new Response(JSON.stringify(body.clients), { headers });
    }
    // Single update
    const existing = JSON.parse(await env.IDEAS_KV.get('sv_clients') || '[]');
    const updated = existing.map(c => c.id === body.id ? { ...c, ...body } : c);
    await env.IDEAS_KV.put('sv_clients', JSON.stringify(updated));
    return new Response(JSON.stringify(updated), { headers });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const existing = JSON.parse(await env.IDEAS_KV.get('sv_clients') || '[]');
    existing.push({ id: crypto.randomUUID(), ...body });
    await env.IDEAS_KV.put('sv_clients', JSON.stringify(existing));
    return new Response(JSON.stringify(existing), { headers });
  }

  if (request.method === 'DELETE') {
    const { id } = await request.json();
    const existing = JSON.parse(await env.IDEAS_KV.get('sv_clients') || '[]');
    const updated = existing.filter(c => c.id !== id);
    await env.IDEAS_KV.put('sv_clients', JSON.stringify(updated));
    return new Response(JSON.stringify(updated), { headers });
  }

  return new Response('Method not allowed', { status: 405, headers });
}
