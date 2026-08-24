export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  if (request.method === 'POST') {
    const { pin } = await request.json();
    const correct = env.SITE_PIN;
    if (!correct) return new Response(JSON.stringify({ ok: false, error: 'PIN not configured' }), { status: 500, headers });
    const ok = pin === correct;
    return new Response(JSON.stringify({ ok }), { headers });
  }

  return new Response('Method not allowed', { status: 405, headers });
}
