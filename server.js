// Episwipe: a TikTok-style swipe player for the TV shows on your Plex server.
//
// People sign in with their own Plex account ("Sign in with Plex" PIN flow) and
// watch with that account's access to this server. The server owner picks which
// shows appear and groups them into categories. All media goes through this
// process, so Plex tokens never reach the browser.
//
// No dependencies: Node.js 20+ only.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, pipeline } = require('stream');

// ---- configuration --------------------------------------------------------------

// Optional .env next to this file (KEY=value per line); real env vars win.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const PLEX_URL = (process.env.PLEX_URL || 'http://localhost:32400').replace(/\/$/, '');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Public address people use to reach Episwipe, e.g. https://episwipe.example.com.
// Used for the Plex sign-in return URL; without it the request's Host header is used.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 90;
const PLEX_TIMEOUT_MS = 15000;
const MAX_BODY = 16 * 1024;

const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CLIENT_FILE = path.join(DATA_DIR, 'client.json');

const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
// Write via a temp file so a crash mid-write never leaves a truncated file.
const writeJson = (f, d, mode = 0o644) => {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode });
  fs.renameSync(tmp, f);
};
const loadData = () => readJson(DATA_FILE, { shows: {} });
const saveData = (d) => writeJson(DATA_FILE, d);

// Stable identifier for this install, required by plex.tv. Installs created
// before the rename keep their original 'swiplex-' id so Plex sees the same device.
const CLIENT_ID = (() => {
  const c = readJson(CLIENT_FILE, null);
  if (c?.id) return c.id;
  const id = `episwipe-${crypto.randomUUID()}`;
  writeJson(CLIENT_FILE, { id });
  return id;
})();
const PLEX_HEADERS = {
  Accept: 'application/json', 'X-Plex-Product': 'Episwipe', 'X-Plex-Version': '1.0',
  'X-Plex-Client-Identifier': CLIENT_ID, 'X-Plex-Platform': 'Web', 'X-Plex-Device-Name': 'Episwipe',
};

// ---- sessions ---------------------------------------------------------------------

// Sessions hold each user's Plex access token for this server, so the file is 0600.
const sessions = readJson(SESSIONS_FILE, {});
const saveSessions = () => writeJson(SESSIONS_FILE, sessions, 0o600);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // Other apps on the same host may share the cookie jar; skip values we can't decode.
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

const isHttps = (req) => (PUBLIC_URL ? PUBLIC_URL.startsWith('https:') : req.headers['x-forwarded-proto'] === 'https');
const cookie = (req, name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

function getSession(req) {
  const c = parseCookies(req);
  // 'swx' is the cookie name used before the rename to Episwipe; still accepted.
  const sid = c.epw || c.swx;
  const s = sid && Object.hasOwn(sessions, sid) ? sessions[sid] : null;
  if (!s) return null;
  if (Date.now() - s.created > SESSION_DAYS * 864e5) { delete sessions[sid]; saveSessions(); return null; }
  return { sid, ...s };
}

// ---- Plex -----------------------------------------------------------------------

class PlexAuthError extends Error {}

let serverId;
async function getServerId() {
  if (!serverId) {
    const r = await fetch(`${PLEX_URL}/identity`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PLEX_TIMEOUT_MS) });
    serverId = (await r.json()).MediaContainer.machineIdentifier;
  }
  return serverId;
}

async function plexTv(p, opts = {}) {
  const r = await fetch(`https://plex.tv${p}`, { ...opts, headers: { ...PLEX_HEADERS, ...opts.headers }, signal: AbortSignal.timeout(PLEX_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`plex.tv ${r.status} on ${p}`);
  return r.json();
}

async function plex(p, token) {
  const sep = p.includes('?') ? '&' : '?';
  const r = await fetch(`${PLEX_URL}${p}${sep}X-Plex-Token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PLEX_TIMEOUT_MS),
  });
  if (r.status === 401) throw new PlexAuthError('Plex rejected token');
  if (!r.ok) throw new Error(`Plex ${r.status} on ${p}`);
  return (await r.json()).MediaContainer;
}

async function allShows(token) {
  const sections = ((await plex('/library/sections', token)).Directory || []).filter((d) => d.type === 'show');
  const lists = await Promise.all(sections.map((s) => plex(`/library/sections/${s.key}/all`, token)));
  return lists.flatMap((l) => l.Metadata || []).map((m) => ({
    id: m.ratingKey, title: m.title, episodes: m.leafCount, year: m.year,
    thumb: m.thumb ? `/plex${m.thumb}` : null,
  }));
}

async function episodes(showId, session) {
  const eps = (await plex(`/library/metadata/${showId}/allLeaves`, session.token)).Metadata || [];
  // An episode without media (e.g. still being added) is skipped, not fatal.
  return eps.filter((e) => e.Media?.[0]?.Part?.[0]).map((e) => {
    const media = e.Media[0], part = media.Part[0];
    // Browsers play H.264 in MP4 natively; everything else goes through Plex's HLS transcoder.
    const direct = media.container === 'mp4' && media.videoCodec === 'h264';
    return {
      id: e.ratingKey, title: e.title, season: e.parentIndex, episode: e.index,
      duration: e.duration, width: media.width, height: media.height,
      src: direct ? `/plex${part.key}` : hlsUrl(e.ratingKey, session.sid), hls: !direct,
    };
  });
}

function hlsUrl(id, sid) {
  // One transcode session per viewer and episode, so two people watching the
  // same episode don't cut each other off.
  const viewer = crypto.createHash('sha256').update(sid).digest('hex').slice(0, 12);
  const q = new URLSearchParams({
    path: `/library/metadata/${id}`, protocol: 'hls', mediaIndex: 0, partIndex: 0,
    directStream: 1, directPlay: 0, fastSeek: 1, videoResolution: '1920x1080',
    session: `episwipe-${id}-${viewer}`, 'X-Plex-Client-Identifier': CLIENT_ID, 'X-Plex-Product': 'Episwipe', 'X-Plex-Platform': 'Chrome',
  });
  return `/plex/video/:/transcode/universal/start.m3u8?${q}`;
}

// Media and images are proxied so tokens stay on the server. Only these paths.
const PROXY_OK = /^\/(library\/parts\/|library\/metadata\/\d+\/(thumb|art)|video\/:\/transcode\/universal\/)/;
async function proxy(req, res, plexPath, token) {
  if (!PROXY_OK.test(plexPath)) return send(res, 403, { error: 'forbidden' });
  const sep = plexPath.includes('?') ? '&' : '?';
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const r = await fetch(`${PLEX_URL}${plexPath}${sep}X-Plex-Token=${encodeURIComponent(token)}`, { headers, signal: ac.signal });
  const out = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = r.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(r.status, out);
  if (!r.body) return res.end();
  // Streams are routinely aborted when people swipe away; that is not an error.
  pipeline(Readable.fromWeb(r.body), res, () => {});
}

// ---- Sign in with Plex (PIN flow) ---------------------------------------------------

function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

async function startLogin(req, res) {
  const pin = await plexTv('/api/v2/pins?strong=true', { method: 'POST' });
  const q = new URLSearchParams({
    clientID: CLIENT_ID, code: pin.code, forwardUrl: `${publicBase(req)}/auth/callback`, 'context[device][product]': 'Episwipe',
  });
  res.writeHead(302, { Location: `https://app.plex.tv/auth#?${q}`, 'Set-Cookie': cookie(req, 'epw_pin', pin.id, 900) });
  res.end();
}

async function finishLogin(req, res) {
  const redirect = (to, cookies = []) => {
    res.writeHead(302, { Location: to, 'Set-Cookie': [cookie(req, 'epw_pin', '', 0), ...cookies] });
    res.end();
  };
  const pinId = parseCookies(req).epw_pin;
  if (!pinId) return redirect('/?login=failed');
  // plex.tv can take a moment to attach the token after redirecting back.
  let authToken;
  for (let i = 0; i < 5 && !authToken; i++) {
    authToken = (await plexTv(`/api/v2/pins/${encodeURIComponent(pinId)}`)).authToken;
    if (!authToken) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!authToken) return redirect('/?login=failed');

  const auth = { headers: { 'X-Plex-Token': authToken } };
  const [user, resources, sid] = await Promise.all([
    plexTv('/api/v2/user', auth),
    plexTv('/api/v2/resources?includeHttps=1', auth),
    getServerId(),
  ]);
  // Only accounts that can access THIS server get in; the token stored is the
  // server-specific access token, not the account token.
  const server = resources.find((r) => r.clientIdentifier === sid && r.accessToken);
  if (!server) return redirect('/?login=denied');

  const id = crypto.randomBytes(24).toString('base64url');
  sessions[id] = {
    userId: user.id, name: user.title || user.username, thumb: user.thumb || null,
    token: server.accessToken, owner: !!server.owned, created: Date.now(),
  };
  saveSessions();
  console.log(`login: ${sessions[id].name}${sessions[id].owner ? ' (owner)' : ''}`);
  redirect('/', [cookie(req, 'epw', id, SESSION_DAYS * 86400), cookie(req, 'swx', '', 0)]);
}

// ---- HTTP -----------------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https://plex.tv https://*.plex.tv", // avatars come from plex.tv
    "media-src 'self' blob:", // hls.js plays through MediaSource blobs
    "worker-src 'self' blob:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(obj));
}

const readBody = (req) => new Promise((ok, fail) => {
  let b = '';
  req.on('data', (c) => {
    b += c;
    if (b.length > MAX_BODY) { fail(new Error('body too large')); req.destroy(); }
  });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { fail(new Error('invalid JSON')); } });
  req.on('error', fail);
});

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, p) {
  const file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
  const rel = path.relative(PUBLIC, file);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(PUBLIC, 'index.html');
  const html = target.endsWith('.html');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
    // The app shell must always be fresh; vendor files can be cached.
    'Cache-Control': html ? 'no-cache' : p.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let session;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/auth/login') return await startLogin(req, res);
    if (p === '/auth/callback') return await finishLogin(req, res);
    if (p === '/auth/logout' && req.method === 'POST') {
      const s = getSession(req);
      if (s) { delete sessions[s.sid]; saveSessions(); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': [cookie(req, 'epw', '', 0), cookie(req, 'swx', '', 0)] });
    }

    if (p.startsWith('/api/') || p.startsWith('/plex/')) {
      session = getSession(req);
      if (!session) return send(res, 401, { error: 'login required' });
    }
    if (p.startsWith('/plex/')) return await proxy(req, res, req.url.slice(5), session.token);

    if (p === '/api/me') return send(res, 200, { name: session.name, thumb: session.thumb, owner: session.owner });
    if (p === '/api/shows') {
      const data = loadData();
      const shows = (await allShows(session.token)).map((s) => ({
        ...s, selected: !!data.shows[s.id], category: data.shows[s.id]?.category || '',
      }));
      return send(res, 200, shows);
    }
    if (p === '/api/select' && req.method === 'POST') {
      if (!session.owner) return send(res, 403, { error: 'only the server owner can manage shows' });
      const { id, selected, category } = await readBody(req);
      if (!/^\d+$/.test(String(id))) return send(res, 400, { error: 'invalid show id' });
      const data = loadData();
      if (selected) data.shows[id] = { category: String(category || '').trim().slice(0, 60) || 'Uncategorized' };
      else delete data.shows[id];
      saveData(data);
      return send(res, 200, { ok: true });
    }
    const m = p.match(/^\/api\/shows\/(\d+)\/episodes$/);
    if (m) return send(res, 200, await episodes(m[1], session));
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    return serveStatic(res, p);
  } catch (e) {
    if (e instanceof PlexAuthError && session) {
      // Token revoked or access removed: end the session so the user signs in again.
      delete sessions[session.sid]; saveSessions();
      if (!res.headersSent) return send(res, 401, { error: 'login required' }, { 'Set-Cookie': [cookie(req, 'epw', '', 0), cookie(req, 'swx', '', 0)] });
    }
    console.error(`${req.method} ${p}:`, e.message);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
    else res.end();
  }
});

// A dropped Plex connection must never take the whole server down.
process.on('unhandledRejection', (e) => console.error('unhandled:', e?.message || e));

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT to another value.` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`Episwipe on http://localhost:${PORT} (Plex: ${PLEX_URL})`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
