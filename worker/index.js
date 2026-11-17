// Kestrel site with a small content panel at /admin.
// Static files are served from the repo as before. The Worker only steps in for:
//   /           the page, with saved edits written in on the way out
//   /admin      the panel
//   /api/*      login and saving
//   /media/*    photos uploaded in the panel
// Saved edits and photos live in one Durable Object (SQLite), so a save is visible right away.

import { DurableObject } from 'cloudflare:workers';
import ADMIN_HTML from './admin.html';
import { GROUPS, clean } from './schema.js';

const COOKIE = 'kcms';
const SESSION_HOURS = 8;
const CACHE_MS = 15000;          // visitors may see a save up to 15 s later; the logged-in editor sees it at once
const MAX_UPLOAD = 1.5 * 1024 * 1024;
const MAX_FAILS = 8;             // failed logins per IP per 15 minutes

let memo = { at: 0, data: null };

/* ---------------- storage ---------------- */

export class CmsStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, created INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS fails (ip TEXT NOT NULL, ts INTEGER NOT NULL)');
  }

  getContent() {
    const rows = this.sql.exec('SELECT v FROM kv WHERE k = ?', 'content').toArray();
    return rows.length ? JSON.parse(rows[0].v) : { fields: {}, updated: null };
  }

  saveContent(changes) {
    const c = this.getContent();
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete c.fields[k];
      else c.fields[k] = v;
    }
    c.updated = Date.now();
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', 'content', JSON.stringify(c));
    // Drop photos nobody uses any more (older than an hour, so an upload waiting to be saved survives).
    const used = new Set(Object.values(c.fields).filter((v) => v.startsWith('/media/')).map((v) => v.slice(7)));
    for (const row of this.sql.exec('SELECT id FROM media WHERE created < ?', Date.now() - 3600000).toArray()) {
      if (!used.has(row.id)) this.sql.exec('DELETE FROM media WHERE id = ?', row.id);
    }
    return c;
  }

  reset() {
    this.sql.exec('DELETE FROM kv');
    this.sql.exec('DELETE FROM media');
    return { fields: {}, updated: Date.now() };
  }

  putMedia(id, type, data) {
    this.sql.exec('INSERT INTO media (id, type, data, created) VALUES (?, ?, ?, ?)', id, type, data, Date.now());
  }

  getMedia(id) {
    const rows = this.sql.exec('SELECT type, data FROM media WHERE id = ?', id).toArray();
    return rows.length ? { type: rows[0].type, data: rows[0].data } : null;
  }

  loginAllowed(ip) {
    this.sql.exec('DELETE FROM fails WHERE ts < ?', Date.now() - 15 * 60000);
    return this.sql.exec('SELECT COUNT(*) AS n FROM fails WHERE ip = ?', ip).one().n < MAX_FAILS;
  }

  loginFailed(ip) {
    this.sql.exec('INSERT INTO fails (ip, ts) VALUES (?, ?)', ip, Date.now());
  }

  loginSucceeded(ip) {
    this.sql.exec('DELETE FROM fails WHERE ip = ?', ip);
  }
}

const store = (env) => env.CMS.get(env.CMS.idFromName('kestrel'));

/* ---------------- router ---------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/admin' || path === '/admin/') return adminPage();
      if (path.startsWith('/api/')) return await api(request, env, url);
      if (path.startsWith('/media/')) return await media(request, env, ctx, path);
      if (path === '/') return await homepage(request, env);
    } catch (err) {
      console.error('kestrel-cms', path, err && err.stack ? err.stack : err);
      if (path.startsWith('/api/')) return json({ error: 'server' }, 500);
      if (path === '/') return env.ASSETS.fetch(request);
      return new Response('Server error', { status: 500 });
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------------- the page ---------------- */

async function homepage(request, env) {
  // Ask for the full file every time: the browser's copy may hold older edits.
  const headers = new Headers(request.headers);
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
  const res = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers }));
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;

  let fields;
  try {
    fields = (await loadContent(env, await isEditor(request, env))).fields || {};
  } catch (err) {
    console.error('kestrel-cms load', err);
    return res; // the original page is better than an error
  }

  const out = new Headers(res.headers);
  out.delete('etag');
  out.delete('last-modified');
  out.set('cache-control', 'no-cache');
  if (!Object.keys(fields).length) return new Response(res.body, { status: res.status, headers: out });
  const rewritten = rewrite(res, fields);
  return new Response(rewritten.body, { status: res.status, headers: out });
}

async function loadContent(env, fresh) {
  if (!fresh && memo.data && Date.now() - memo.at < CACHE_MS) return memo.data;
  const data = await store(env).getContent();
  memo = { at: Date.now(), data };
  return data;
}

function telHref(phone) {
  const digits = phone.replace(/[^\d]/g, '');
  if (phone.trim().startsWith('+')) return 'tel:+' + digits;
  if (digits.length === 10) return 'tel:+1' + digits;
  return 'tel:' + digits;
}

function rewrite(res, f) {
  const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
  return new HTMLRewriter()
    .on('[data-cms]', {
      element(el) {
        const k = el.getAttribute('data-cms');
        if (!has(k)) return;
        const v = el.getAttribute('data-cms-fmt') === 'usd' ? '$' + f[k] : f[k];
        el.setInnerContent(v); // text, escaped
      },
    })
    .on('[data-cms-attrs]', {
      element(el) {
        for (const pair of el.getAttribute('data-cms-attrs').split(',')) {
          const [attr, k] = pair.split(':');
          if (has(k)) el.setAttribute(attr, f[k]);
        }
      },
    })
    .on('[data-cms-tel]', {
      element(el) {
        const k = el.getAttribute('data-cms-tel');
        if (has(k)) el.setAttribute('href', telHref(f[k]));
      },
    })
    .on('[data-cms-img]', {
      element(el) {
        const k = el.getAttribute('data-cms-img');
        if (!has(k)) return;
        if (el.tagName === 'link') {
          el.setAttribute('href', f[k]);
          el.removeAttribute('imagesrcset');
          el.removeAttribute('imagesizes');
        } else {
          el.setAttribute('src', f[k]);
          el.removeAttribute('srcset');
          el.removeAttribute('sizes');
        }
      },
    })
    .transform(res);
}

/* ---------------- photos ---------------- */

async function media(request, env, ctx, path) {
  const m = path.match(/^\/media\/([a-f0-9]{24}\.(?:webp|jpg|png))$/);
  if (!m || request.method !== 'GET') return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const item = await store(env).getMedia(m[1]);
  if (!item) return new Response('Not found', { status: 404 });
  const res = new Response(item.data, {
    headers: {
      'content-type': item.type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

const IMAGE_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

function looksLike(type, b) {
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === 'image/webp') return String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP';
  return false;
}

/* ---------------- panel and API ---------------- */

function adminPage() {
  return new Response(ADMIN_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      ...extra,
    },
  });
}

async function api(request, env, url) {
  const route = url.pathname.slice(5);
  const method = request.method;
  const configured = Boolean(env.ADMIN_PASSWORD);

  if (method === 'POST') {
    // Writes only from this site's own pages.
    if (request.headers.get('origin') !== url.origin) return json({ error: 'origin' }, 403);
  }

  if (route === 'session' && method === 'GET') {
    return json({ configured, loggedIn: await isEditor(request, env), user: env.ADMIN_USER || 'admin' });
  }

  if (route === 'login' && method === 'POST') {
    if (!configured) return json({ error: 'not_configured' }, 503);
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    const s = store(env);
    if (!(await s.loginAllowed(ip))) return json({ error: 'too_many' }, 429);
    let body = {};
    try { body = await request.json(); } catch {}
    const userOk = String(body.user || '').trim().toLowerCase() === String(env.ADMIN_USER || 'admin').toLowerCase();
    const passOk = crypto.subtle.timingSafeEqual(await sha256(String(body.pass || '')), await sha256(env.ADMIN_PASSWORD));
    if (!(userOk && passOk)) {
      await s.loginFailed(ip);
      return json({ error: 'wrong' }, 401);
    }
    await s.loginSucceeded(ip);
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${await makeToken(env)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}` });
  }

  if (route === 'logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  // Everything below needs a login.
  if (!(await isEditor(request, env))) return json({ error: 'login' }, 401);

  if (route === 'content' && method === 'GET') {
    const c = await store(env).getContent();
    return json({ fields: c.fields, updated: c.updated, groups: GROUPS });
  }

  if (route === 'content' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const changes = {};
    const errors = {};
    for (const [k, raw] of Object.entries((body && body.changes) || {})) {
      const r = clean(k, raw);
      if (r.error) errors[k] = r.error;
      else changes[k] = r.value;
    }
    if (Object.keys(errors).length) return json({ error: 'invalid', fields: errors }, 400);
    if (!Object.keys(changes).length) return json({ error: 'nothing' }, 400);
    const c = await store(env).saveContent(changes);
    memo = { at: Date.now(), data: c };
    return json({ ok: true, fields: c.fields, updated: c.updated });
  }

  if (route === 'media' && method === 'POST') {
    const type = (request.headers.get('content-type') || '').split(';')[0].trim();
    const ext = IMAGE_TYPES[type];
    if (!ext) return json({ error: 'type' }, 415);
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_UPLOAD) return json({ error: 'too_big' }, 413);
    if (buf.byteLength < 64 || !looksLike(type, new Uint8Array(buf, 0, 12))) return json({ error: 'not_image' }, 400);
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('') + '.' + ext;
    await store(env).putMedia(id, type, buf);
    return json({ ok: true, url: '/media/' + id });
  }

  if (route === 'reset' && method === 'POST') {
    const c = await store(env).reset();
    memo = { at: Date.now(), data: c };
    return json({ ok: true });
  }

  return json({ error: 'not_found' }, 404);
}

/* ---------------- sessions ---------------- */

const enc = (s) => new TextEncoder().encode(s);
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function sha256(s) {
  return crypto.subtle.digest('SHA-256', enc(s));
}

// The signing key comes from the password, so changing the password logs everyone out.
async function sessionKey(env) {
  const raw = await sha256('kestrel-cms-session|' + (env.ADMIN_USER || 'admin') + '|' + env.ADMIN_PASSWORD);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeToken(env) {
  const payload = b64u(enc(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600000 })));
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), enc(payload));
  return payload + '.' + b64u(sig);
}

async function isEditor(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+)'));
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  try {
    if (!(await crypto.subtle.verify('HMAC', await sessionKey(env), unb64u(sig), enc(payload)))) return false;
    return JSON.parse(new TextDecoder().decode(unb64u(payload))).exp > Date.now();
  } catch {
    return false;
  }
}

