export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  if (request.method === 'GET') {
    const data = await env.IDEAS_KV.get('tasks');
    return new Response(data || '[]', { headers });
  }

  if (request.method === 'POST') {
    const body = await request.json();
    const existing = JSON.parse(await env.IDEAS_KV.get('tasks') || '[]');
    existing.push({ id: crypto.randomUUID(), text: body.text, author: body.author, importance: body.importance || 5, done: false, ts: Date.now() });
    await env.IDEAS_KV.put('tasks', JSON.stringify(existing));
    return new Response(JSON.stringify(existing), { headers });
  }

  if (request.method === 'PATCH') {
    const body = await request.json();
    const existing = JSON.parse(await env.IDEAS_KV.get('tasks') || '[]');
    const updated = existing.map(item => {
      if (item.id !== body.id) return item;
      if (body.importance !== undefined) return { ...item, importance: body.importance };
      return { ...item, done: !item.done };
    });
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
