import { scoreLead } from './scoring.js';

export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  try {

    // ---------------------------------------------------------------------
    // GET — fetch all leads
    // ---------------------------------------------------------------------
    if (request.method === 'GET') {
      const url    = new URL(request.url);
      const tier   = url.searchParams.get('tier') || url.searchParams.get('score');
      const status = url.searchParams.get('status');
      const suburb = url.searchParams.get('suburb');
      const search = url.searchParams.get('search');
      const wstat  = url.searchParams.get('website_status');

      let query  = 'SELECT * FROM leads WHERE 1=1';
      const vals = [];
      if (tier)   { query += ' AND tier = ?';                        vals.push(tier); }
      if (status) { query += ' AND status = ?';                      vals.push(status); }
      if (wstat)  { query += ' AND website_status = ?';              vals.push(wstat); }
      if (suburb) { query += ' AND suburb LIKE ?';                   vals.push(`%${suburb}%`); }
      if (search) { query += ' AND (name LIKE ? OR address LIKE ?)'; vals.push(`%${search}%`, `%${search}%`); }

      // Best lead first. The old ORDER BY used the `score` column, which no
      // longer exists — that is what was throwing a 1101 on every page load.
      query += ' ORDER BY lead_score DESC, name ASC';

      const result = await env.VELOX_DB.prepare(query).bind(...vals).all();
      return new Response(JSON.stringify(result.results || []), { headers });
    }

    // ---------------------------------------------------------------------
    // POST — manually add a single lead
    // ---------------------------------------------------------------------
    if (request.method === 'POST') {
      const body = await request.json();
      const { name, category, suburb, address, phone, website,
              email, contact_name, referral_source, notes } = body;
      if (!name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers });

      // A manually added lead is never really "checked" — only verify.js can
      // say that. Social links are the one thing we can tell at a glance.
      const w = (website || '').toLowerCase();
      const isSocial = w.includes('facebook.com') || w.includes('instagram.com')
                    || w.includes('linktr.ee')   || w.includes('tiktok.com');
      const website_status = isSocial ? 'social_only' : 'unchecked';

      const s = scoreLead({ website_status, phone, email, contact_name });

      const existing = await env.VELOX_DB.prepare(
        'SELECT id FROM leads WHERE lower(name) = ? AND lower(suburb) = ?'
      ).bind(name.toLowerCase(), (suburb || '').toLowerCase()).first();
      if (existing) {
        return new Response(JSON.stringify({ error: 'Lead already exists', duplicate: true }), { status: 409, headers });
      }

      await env.VELOX_DB.prepare(
        `INSERT INTO leads
           (name, category, suburb, address, phone, website, email, contact_name,
            website_status, score_reason, lead_score, tier, referral_source, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        name, category || '', suburb || '', address || '', phone || '', website || '',
        email || null, contact_name || null,
        website_status, s.score_reason, s.lead_score, s.tier,
        referral_source || 'manual', notes || ''
      ).run();

      return new Response(JSON.stringify({ ok: true, tier: s.tier, lead_score: s.lead_score }), { headers });
    }

    // ---------------------------------------------------------------------
    // PATCH — update a lead, then rescore unless the tier is locked
    // ---------------------------------------------------------------------
    if (request.method === 'PATCH') {
      const body = await request.json();
      const { id, status, notes, contact_method, date_contacted, follow_up_date,
              name, category, suburb, address, phone, website, email, contact_name,
              website_status, real_website, verify_note, tier, score_locked } = body;
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });

      // Picking a tier by hand locks it; clearing it unlocks.
      const lock = tier ? 1 : (score_locked === 0 ? 0 : null);

      await env.VELOX_DB.prepare(
        `UPDATE leads SET
          status         = COALESCE(?, status),
          notes          = COALESCE(?, notes),
          contact_method = COALESCE(?, contact_method),
          date_contacted = COALESCE(?, date_contacted),
          follow_up_date = COALESCE(?, follow_up_date),
          name           = COALESCE(?, name),
          category       = COALESCE(?, category),
          suburb         = COALESCE(?, suburb),
          address        = COALESCE(?, address),
          phone          = COALESCE(?, phone),
          website        = COALESCE(?, website),
          email          = COALESCE(?, email),
          contact_name   = COALESCE(?, contact_name),
          website_status = COALESCE(?, website_status),
          real_website   = COALESCE(?, real_website),
          verify_note    = COALESCE(?, verify_note),
          tier           = COALESCE(?, tier),
          score_locked   = COALESCE(?, score_locked)
         WHERE id = ?`
      ).bind(
        status ?? null, notes ?? null, contact_method ?? null,
        date_contacted ?? null, follow_up_date ?? null,
        name ?? null, category ?? null, suburb ?? null, address ?? null,
        phone ?? null, website ?? null, email ?? null, contact_name ?? null,
        website_status ?? null, real_website ?? null, verify_note ?? null,
        tier ?? null, lock,
        id
      ).run();

      // Rescore from the saved row so an edited phone or email counts straight
      // away — unless Phil set the tier himself, in which case leave it alone.
      const fresh = await env.VELOX_DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first();
      let scored = null;
      if (fresh && Number(fresh.score_locked) !== 1) {
        scored = scoreLead(fresh);
        await env.VELOX_DB.prepare(
          'UPDATE leads SET lead_score = ?, tier = ?, score_reason = ? WHERE id = ?'
        ).bind(scored.lead_score, scored.tier, scored.score_reason, id).run();
      }

      return new Response(JSON.stringify({ ok: true, ...(scored || {}) }), { headers });
    }

    // ---------------------------------------------------------------------
    // DELETE
    // ---------------------------------------------------------------------
    if (request.method === 'DELETE') {
      const { id } = await request.json();
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers });
      await env.VELOX_DB.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    return new Response('Method not allowed', { status: 405, headers });

  } catch (err) {
    // Without this, any thrown error is a bare Cloudflare "1101" with no clue
    // what went wrong. That cost an afternoon once.
    return new Response(JSON.stringify({
      error: String(err?.message || err),
      hint: 'A "no such column" error means the database and this file disagree. Run PRAGMA table_info(leads); in the D1 console.',
    }, null, 2), { status: 500, headers });
  }
}
