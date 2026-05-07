'use strict';

// ============================================================================
// AUTH MIDDLEWARE — verifieert rt_session cookie via adrlab.cloud/auth/check
// Gebruikers hebben de '4d' rol nodig (instelbaar via adrlab.cloud/beheer)
// ============================================================================

const https = require('https');

const SESSION_COOKIE  = 'rt_session';
const AUTH_CHECK_HOST = 'adrlab.cloud';
const LOGIN_URL       = 'https://adrlab.cloud/login';

// In-memory cache om /auth/check niet bij elk request te hoeven aanroepen
// Sleutel = token, waarde = { ok: bool, expires: timestamp }
const authCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuten

function getCached(token) {
  const entry = authCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expires) { authCache.delete(token); return null; }
  return entry.ok;
}

function setCached(token, ok) {
  authCache.set(token, { ok, expires: Date.now() + CACHE_TTL_MS });
  // Ruim verlopen entries op als de cache te groot wordt
  if (authCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of authCache) {
      if (now > v.expires) authCache.delete(k);
    }
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k.trim()] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function remoteAuthCheck(token, host, path) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: AUTH_CHECK_HOST,
        path: '/auth/check',
        method: 'GET',
        headers: {
          Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
          'X-Original-Host': host,
          'X-Original-URI': path,
        },
      },
      (res) => { resolve(res.statusCode === 200); }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

module.exports = function requireAuth(req, res, next) {
  const p = req.path || '/';

  // Socket.io en health-endpoint hoeven geen auth
  if (p.startsWith('/socket.io') || p === '/health') return next();

  const cookies = parseCookies(req.headers.cookie || '');
  const token   = cookies[SESSION_COOKIE];

  function deny() {
    // API-requests krijgen een 401 JSON, paginaverzoeken een redirect
    if (req.xhr || (req.headers.accept || '').includes('application/json')) {
      return res.status(401).json({ error: 'Niet ingelogd' });
    }
    const full = `https://${req.get('host') || '4d.adrlab.cloud'}${req.originalUrl}`;
    return res.redirect(`${LOGIN_URL}?redirect=${encodeURIComponent(full)}`);
  }

  if (!token) return deny();

  // Controleer cache
  const cached = getCached(token);
  if (cached === true)  return next();
  if (cached === false) return deny();

  // Verifieer bij adrlab.cloud (met X-Original-Host zodat de 4d-regel matcht)
  const reqHost = req.get('host') || '4d.adrlab.cloud';
  remoteAuthCheck(token, reqHost, p)
    .then((ok) => {
      setCached(token, ok);
      return ok ? next() : deny();
    })
    .catch(() => deny());
};
