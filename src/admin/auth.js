import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'ep_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 h
const MAX_FAILURES = 5; // essais ratés avant blocage…
const LOCK_MS = 15 * 60 * 1000; // …pendant 15 min

const digest = (value) => createHash('sha256').update(String(value)).digest();
// Comparaison en temps constant : on ne peut pas deviner le mot de passe en chronométrant.
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* cookie mal formé : ignoré */
    }
  }
  return cookies;
}

const isHttps = (req) => req.secure || req.get('x-forwarded-proto') === 'https';
const cookie = (value, maxAgeSeconds, secure) =>
  `${COOKIE_NAME}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeSeconds)}${secure ? '; Secure' : ''}`;

/**
 * Authentification de l'espace admin : identifiant + mot de passe (fichier .env),
 * session dans un cookie signé, blocage après plusieurs échecs.
 * localOnly : l'admin est invisible pour les requêtes venant d'Internet via Cloudflare Tunnel
 * (elles portent l'en-tête CF-Connecting-IP), donc accessible seulement en local / Tailscale.
 */
export function createAdminAuth({ user = 'admin', password = '', secret, localOnly = false } = {}) {
  const key = secret || randomBytes(32).toString('hex');
  const failures = new Map();
  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');
  const clientIp = (req) => req.get('cf-connecting-ip') || req.socket.remoteAddress || 'inconnu';

  return {
    enabled: Boolean(password),

    isBlockedOrigin(req) {
      return localOnly && Boolean(req.get('cf-connecting-ip'));
    },

    isLocked(req) {
      const entry = failures.get(clientIp(req));
      return Boolean(entry && entry.count >= MAX_FAILURES && Date.now() < entry.until);
    },

    checkCredentials(req, username, pass) {
      // & (et pas &&) : on compare toujours les deux, pour ne rien révéler.
      const ok = Boolean(safeEqual(username ?? '', user) & safeEqual(pass ?? '', password));
      const ip = clientIp(req);
      if (ok) {
        failures.delete(ip);
        return true;
      }
      const entry = failures.get(ip);
      const count = entry && Date.now() < entry.until ? entry.count + 1 : 1;
      failures.set(ip, { count, until: Date.now() + LOCK_MS });
      return false;
    },

    startSession(req, res) {
      const payload = `${user}|${Date.now() + SESSION_TTL_MS}`;
      const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
      res.append('Set-Cookie', cookie(token, SESSION_TTL_MS / 1000, isHttps(req)));
    },

    endSession(req, res) {
      res.append('Set-Cookie', cookie('', 0, isHttps(req)));
    },

    isAuthenticated(req) {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      if (!token) return false;
      const [encoded, signature] = token.split('.');
      if (!encoded || !signature) return false;
      const payload = Buffer.from(encoded, 'base64url').toString();
      if (!safeEqual(sign(payload), signature)) return false;
      const expires = Number(payload.slice(payload.lastIndexOf('|') + 1));
      return Number.isFinite(expires) && expires > Date.now();
    },
  };
}
