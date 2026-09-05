/**
 * TITRITE HOUSE — Cloudflare Worker (version finale fusionnée)
 * ------------------------------------------------------------
 * Ce fichier remplace intégralement votre worker.js actuel.
 * Il contient :
 *  - votre logique de chat existante (Groq), inchangée dans son comportement
 *  - le catalogue public   : GET  /api/products
 *  - les commandes         : POST /api/orders
 *  - la newsletter         : POST /api/newsletter
 *  - l'espace admin (protégé par ADMIN_TOKEN) : /api/admin/products, /api/admin/orders, ...
 *  - l'enregistrement des conversations du chat dans chat_messages
 *
 * Dépendance à installer avant déploiement :
 *   npm install @neondatabase/serverless
 *
 * Variables d'environnement à configurer (wrangler secret put <NOM>) :
 *   GROQ_API_KEY   (déjà existante — ne pas toucher)
 *   GROQ_MODEL     (déjà existante, optionnelle — ne pas toucher)
 *   DATABASE_URL   (nouvelle — connection string Neon, voir GUIDE-NEON.md)
 *   ADMIN_TOKEN    (nouvelle — mot de passe de la page admin.html)
 *
 * Déploiement : `wrangler deploy` depuis le dossier du projet (nécessite npm install ci-dessus).
 */

import { neon } from '@neondatabase/serverless';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function requireAdmin(request, env) {
  const token = request.headers.get('X-Admin-Token');
  return token && env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

async function logChatMessage(sql, sessionId, role, content, lang) {
  try {
    await sql`
      INSERT INTO chat_messages (session_id, role, content, lang)
      VALUES (${sessionId}, ${role}, ${content}, ${lang || null})
    `;
  } catch (err) {
    console.error('chat log failed', err);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const sql = neon(env.DATABASE_URL);
    const parts = url.pathname.split('/').filter(Boolean);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ===================== Catalogue public =====================
    if (url.pathname === '/api/products' && request.method === 'GET') {
      try {
        const rows = await sql`
          SELECT id, slug, name_en, name_fr, name_ar, category, image_url,
                 description_en, description_fr, description_ar, price, currency
          FROM products
          WHERE is_active = true
          ORDER BY created_at ASC
        `;
        return json(rows);
      } catch (err) {
        return json({ error: 'db_error', message: String(err) }, 500);
      }
    }

    // ===================== Commandes =====================
    if (url.pathname === '/api/orders' && request.method === 'POST') {
      try {
        const body = await request.json();
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) return json({ error: 'no_items' }, 400);

        const [order] = await sql`
          INSERT INTO orders (customer_name, phone, city, channel, notes)
          VALUES (${body.customer_name || null}, ${body.phone || null}, ${body.city || null},
                  ${body.channel || 'whatsapp'}, ${body.notes || null})
          RETURNING id
        `;

        for (const it of items) {
          await sql`
            INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
            VALUES (${order.id}, ${it.product_id || null}, ${it.product_name}, ${it.quantity || 1}, ${it.unit_price || null})
          `;
        }

        return json({ ok: true, order_id: order.id });
      } catch (err) {
        return json({ error: 'db_error', message: String(err) }, 500);
      }
    }

    // ===================== Newsletter =====================
    if (url.pathname === '/api/newsletter' && request.method === 'POST') {
      try {
        const body = await request.json();
        const email = (body.email || '').trim().toLowerCase();
        if (!email || !email.includes('@')) return json({ error: 'invalid_email' }, 400);

        await sql`
          INSERT INTO newsletter_subscribers (email, lang)
          VALUES (${email}, ${body.lang || null})
          ON CONFLICT (email) DO NOTHING
        `;
        return json({ ok: true });
      } catch (err) {
        return json({ error: 'db_error', message: String(err) }, 500);
      }
    }

    // ===================== Espace admin (protégé) =====================
    if (parts[0] === 'api' && parts[1] === 'admin') {
      if (!requireAdmin(request, env)) {
        return json({ error: 'unauthorized' }, 401);
      }

      if (parts[2] === 'products' && !parts[3] && request.method === 'GET') {
        try {
          const rows = await sql`SELECT * FROM products ORDER BY created_at DESC`;
          return json(rows);
        } catch (err) {
          return json({ error: 'db_error', message: String(err) }, 500);
        }
      }

      if (parts[2] === 'products' && !parts[3] && request.method === 'POST') {
        try {
          const b = await request.json();
          if (!b.slug || !b.name_en) return json({ error: 'missing_fields' }, 400);
          const [row] = await sql`
            INSERT INTO products (slug, name_en, name_fr, name_ar, category, image_url,
                                   description_en, description_fr, description_ar, price, currency, is_active)
            VALUES (${b.slug}, ${b.name_en}, ${b.name_fr || null}, ${b.name_ar || null},
                    ${b.category || 'spice'}, ${b.image_url || null},
                    ${b.description_en || null}, ${b.description_fr || null}, ${b.description_ar || null},
                    ${b.price ?? null}, ${b.currency || 'MAD'}, ${b.is_active !== false})
            RETURNING *
          `;
          return json(row, 201);
        } catch (err) {
          return json({ error: 'db_error', message: String(err) }, 500);
        }
      }

      if (parts[2] === 'products' && parts[3] && request.method === 'PUT') {
        try {
          const id = parts[3];
          const b = await request.json();
          const [row] = await sql`
            UPDATE products SET
              slug = ${b.slug}, name_en = ${b.name_en}, name_fr = ${b.name_fr || null},
              name_ar = ${b.name_ar || null}, category = ${b.category || 'spice'},
              image_url = ${b.image_url || null}, description_en = ${b.description_en || null},
              description_fr = ${b.description_fr || null}, description_ar = ${b.description_ar || null},
              price = ${b.price ?? null}, currency = ${b.currency || 'MAD'},
              is_active = ${b.is_active !== false}, updated_at = now()
            WHERE id = ${id}
            RETURNING *
          `;
          if (!row) return json({ error: 'not_found' }, 404);
          return json(row);
        } catch (err) {
          return json({ error: 'db_error', message: String(err) }, 500);
        }
      }

      if (parts[2] === 'products' && parts[3] && request.method === 'DELETE') {
        try {
          await sql`DELETE FROM products WHERE id = ${parts[3]}`;
          return json({ ok: true });
        } catch (err) {
          return json({ error: 'db_error', message: String(err) }, 500);
        }
      }

      if (parts[2] === 'orders' && !parts[3] && request.method === 'GET') {
        try {
          const orders = await sql`SELECT * FROM orders ORDER BY created_at DESC LIMIT 200`;
          const items = await sql`SELECT * FROM order_items ORDER BY created_at ASC`;
          const byOrder = {};
          for (const it of items) {
            (byOrder[it.order_id] ||= []).push(it);
          }
          const result = orders.map(o => ({ ...o, items: byOrder[o.id] || [] }));
          return json(result);
        } catch (err) {
          return json({ error: 'db_error', message: String(err) }, 500);
        }
      }

      if (parts[2] === 'orders' && parts[3] && request.method === 'PATCH') {
        try {
          const b = await request.json();
          const [row] = await sql`
            UPDATE orders SET status = ${b.status}, updated_at = now()
            WHERE id = ${parts[3]}
            RETURNING *
          `;
          if (!row) return json({ error: 'not_found' }, 404);
          return json(row);
        } catch (err) {
          return json({ error: 'db_error', message: String(err) }, 500);
        }
      }

      if (parts[2] === 'newsletter' && request.method === 'GET') {
        try {
          const rows = await sql`SELECT * FROM newsletter_subscribers ORDER BY created_at DESC LIMIT 500`;
          return json(rows);
        } catch (err) {
          return json({ error: 'db_error', message: String(err) }, 500);
        }
      }

      if (parts[2] === 'messages' && request.method === 'GET') {
        try {
          const rows = await sql`SELECT * FROM messages ORDER BY created_at DESC LIMIT 500`;
          return json(rows);
        } catch (err) {
          return json({ error: 'db_error', message: String(err) }, 500);
        }
      }

      return json({ error: 'not_found' }, 404);
    }

    // ===================== Chat (logique existante conservée) =====================
    if (request.method !== 'POST' || url.pathname !== '/') {
      return json({ error: 'not_found' }, 404);
    }

    try {
      const body = await request.json();
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const sessionId = body.session_id || null;
      const lang = body.lang || null;
      const lastUserMsg = messages[messages.length - 1];

      // enregistrement du message utilisateur (n'affecte pas la réponse en cas d'échec)
      if (sessionId && lastUserMsg) {
        ctx.waitUntil(logChatMessage(sql, sessionId, 'user', lastUserMsg.content, lang));
      }

      const systemPrompt = {
        role: 'system',
        content:
          "أنت المساعد الرقمي لمتجر TITRITE HOUSE (Taste the Soul of Morocco)، متجر مغربي يجمع التوابل والمكونات الطبيعية المتجذرة في التقاليد المغربية، مختارة بعناية ومقدَّمة دون مبالغة.\n\n" +
          "منتجات المتجر:\n" +
          "- توابل: كمون (Cumin)، إسكَنجبير/زنجبيل (Gingembre)، فلفل أسود كامل (Poivre Noir en Grains)، قرفة (Cannelle)، الخرقوم/كركم (Curcuma)، فلفل حلو (Piment Doux)، رأس الحانوت (Ras El Hanout)، كزبرة (Coriandre)\n" +
          "- منتجات طبيعية: هريسة (Harissa) — فلفل حار مطحون محضّر وفق تقاليد البيت\n\n" +
          "الموقع والتواصل:\n" +
          "- الموقع: أكادير، المغرب — التوصيل متوفر إلى مدن أخرى\n" +
          "- رقم التواصل عبر واتساب: +212 6 61 08 95 28\n" +
          "- لا توجد أسعار ثابتة معروضة أونلاين؛ الأسعار تُعطى عند التواصل عبر واتساب حسب الكمية والمدينة\n\n" +
          "تعليمات الرد:\n" +
          "رُدّ دائمًا بنفس لغة آخر رسالة من المستخدم (عربية، دارجة مغربية، فرنسية أو إنجليزية حسب الحالة). " +
          "كن ودودًا، مهنيًا ومختصرًا (لا تكتب فقرات طويلة إلا إذا طُلب منك ذلك)، وحافظ على نبرة تعكس أصالة وطبيعية منتجات المتجر المغربية. " +
          "إذا سُئلت عن أسعار دقيقة، أو أراد الزائر الطلب، وجّهه بلطف للتواصل عبر واتساب مباشرة على الرقم أعلاه. " +
          "لا تخترع معلومات غير موجودة هنا (كالأسعار الدقيقة أو مكونات غير مذكورة)؛ في حال عدم معرفتك بإجابة دقيقة، وجّه الزائر للتواصل مباشرة. " +
          "لا تدّعِ أنك إنسان — أنت مساعد افتراضي للمتجر.",
      };

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.GROQ_MODEL || 'llama-3.1-8b-instant',
          messages: [systemPrompt, ...messages],
          temperature: 0.6,
          max_tokens: 1500,
          reasoning_format: 'hidden',
        }),
      });

      const data = await groqRes.json();

      if (!groqRes.ok) {
        return json({ error: data.error || 'Erreur Groq' }, groqRes.status);
      }

      if (
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        typeof data.choices[0].message.content === 'string'
      ) {
        data.choices[0].message.content = data.choices[0].message.content
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<think>[\s\S]*$/gi, '')
          .trim();
      }

      const reply = data.choices?.[0]?.message?.content || '';

      // enregistrement de la réponse de l'assistant
      if (sessionId && reply) {
        ctx.waitUntil(logChatMessage(sql, sessionId, 'assistant', reply, lang));
      }

      return json({ reply });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

