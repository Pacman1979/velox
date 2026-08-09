export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  if (request.method === 'GET') {
    const data = await env.IDEAS_KV.get('tasks');
    return new Response(data || '[]', { headers });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const existing = JSON.parse(await env.IDEAS_KV.get('tasks') || '[]');
    existing.push({ id: crypto.randomUUID(), ...body, done: false, ts: Date.now() });
    await env.IDEAS_KV.put('tasks', JSON.stringify(existing));
    return new Response(JSON.stringify(existing), { headers });
  }

  if (request.method === 'PATCH') {
    const { id } = await request.json();
    const existing = JSON.parse(await env.IDEAS_KV.get('tasks') || '[]');
    const updated = existing.map(item => item.id === id ? { ...item, done: !item.done } : item);
    await env.IDEAS_KV.put('tasks', JSON.stringify(updated));
    return new Response(JSON.stringify(updated), { headers });
  }

  if (request.method === 'DELETE') {
    const { id } = await request.json();
    const existing = JSON.parse(await env.IDEAS_KV.get('tasks') || '[]');
    const updated = existing.filter(item => item.id !== id);
    await env.IDEAS_KV.put('tasks', JSON.stringify(updated));
    return new Response(JSON.stringify(updated), { headers });
  }

  return new Response('Method not allowed', { status: 405, headers });
}
