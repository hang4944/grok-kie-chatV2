import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, 'data');
const usersFile = join(dataDir, 'users.json');
const sessions = new Map();
const apiBase = (process.env.KIE_API_BASE || 'https://api.kie.ai').replace(/\/$/, '');
const model = process.env.KIE_MODEL || 'grok-4-1-fast';
const staticTypes = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function parseCookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => { const i = x.indexOf('='); return [x.slice(0, i).trim(), decodeURIComponent(x.slice(i + 1))]; })); }
function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function hash(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function matches(password, stored) { const [salt, value] = stored.split(':'); const a = Buffer.from(value, 'hex'); const b = scryptSync(password, salt, 64); return a.length === b.length && timingSafeEqual(a, b); }
async function users() { try { return JSON.parse(await readFile(usersFile, 'utf8')); } catch { return []; } }
async function saveUsers(value) { await mkdir(dataDir, { recursive: true }); await writeFile(usersFile, JSON.stringify(value, null, 2), { mode: 0o600 }); }
async function bootstrap() { const list = await users(); if (!list.length && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) await saveUsers([{ username: process.env.ADMIN_USERNAME, password: hash(process.env.ADMIN_PASSWORD), role: 'admin', createdAt: new Date().toISOString() }]); }
function auth(req) { const token = parseCookies(req).grok_session; const session = token && sessions.get(token); if (!session || session.expires < Date.now()) return null; return session; }
function makeSession(username) { const token = randomBytes(32).toString('base64url'); sessions.set(token, { username, expires: Date.now() + 7 * 864e5 }); return token; }
async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw new Error('Request too large'); } return raw ? JSON.parse(raw) : {}; }
function safeMessage(error) { return error instanceof Error ? error.message : 'Request failed'; }

async function handleChat(req, res, session) {
  if (!process.env.KIE_API_KEY) return json(res, 503, { error: 'KIE_API_KEY is not configured on the server.' });
  const payload = await body(req);
  if (!Array.isArray(payload.messages) || !payload.messages.length) return json(res, 400, { error: 'messages is required' });
  const upstream = await fetch(`${apiBase}/${encodeURIComponent(model)}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.KIE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: payload.messages, stream: true, temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.7 })
  });
  if (!upstream.ok || !upstream.body) return json(res, upstream.status, { error: `KIE request failed: ${await upstream.text()}` });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const reader = upstream.body.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); } } finally { res.end(); reader.releaseLock(); }
}

async function serveStatic(res, pathname) {
  const file = pathname === '/' ? '/index.html' : pathname;
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(file) || file.includes('..')) return json(res, 404, { error: 'Not found' });
  try { const content = await readFile(join(root, 'public', file)); res.writeHead(200, { 'content-type': staticTypes[extname(file)] || 'application/octet-stream' }); res.end(content); } catch { json(res, 404, { error: 'Not found' }); }
}

await bootstrap();
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`); const session = auth(req);
    if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user: session?.username || null, model });
    if (req.method === 'POST' && url.pathname === '/api/login') { const { username, password } = await body(req); const user = (await users()).find(x => x.username === username); if (!user || !matches(String(password || ''), user.password)) return json(res, 401, { error: '账号或密码错误。' }); const token = makeSession(user.username); res.setHeader('set-cookie', `grok_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`); return json(res, 200, { user: user.username }); }
    if (req.method === 'POST' && url.pathname === '/api/logout') { const token = parseCookies(req).grok_session; if (token) sessions.delete(token); res.setHeader('set-cookie', 'grok_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/chat') { if (!session) return json(res, 401, { error: '请先登录。' }); return handleChat(req, res, session); }
    return serveStatic(res, url.pathname);
  } catch (error) { json(res, 500, { error: safeMessage(error) }); }
}).listen(port, '0.0.0.0', () => console.log(`Grok KIE Chat listening on ${port}`));
