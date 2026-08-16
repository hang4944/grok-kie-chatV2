import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);
const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, 'data'), usersFile = join(dataDir, 'users.json'), modelsFile = join(dataDir, 'models.json'), conversationsFile = join(dataDir, 'conversations.json');
const sessions = new Map(), apiBase = (process.env.KIE_API_BASE || 'https://api.kie.ai').replace(/\/$/, '');
// Verified from the KIE Responses API snippets supplied by the administrator.
const defaults = [
  { id: 'grok-4-3', label: 'Grok 4.3', group: 'Grok', protocol: 'responses', endpoint: '/grok/v1/responses' },
  { id: 'grok-4-5', label: 'Grok 4.5', group: 'Grok', protocol: 'responses', endpoint: '/grok/v1/responses' },
  { id: 'grok-4-6', label: 'Grok 4.6', group: 'Grok', protocol: 'responses', endpoint: '/grok/v1/responses' },
];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => { const at = x.indexOf('='); return [x.slice(0, at).trim(), decodeURIComponent(x.slice(at + 1))]; }));
const hash = (password, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const validPassword = (password, value) => { const [salt, encoded] = value.split(':'), a = Buffer.from(encoded, 'hex'), b = scryptSync(password, salt, 64); return a.length === b.length && timingSafeEqual(a, b); };
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } }
async function save(file, data) { await mkdir(dataDir, { recursive: true }); await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 }); }
async function users() { return readJson(usersFile, []); }
async function conversations() { return readJson(conversationsFile, []); }
function isCurrentCatalog(list) { return Array.isArray(list) && defaults.every(model => list.some(item => item.id === model.id && item.protocol === 'responses' && item.endpoint)); }
async function models() { const list = await readJson(modelsFile, defaults); return isCurrentCatalog(list) ? list : defaults; }
async function bootstrap() { const list = await users(); if (!list.length && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) await save(usersFile, [{ username: process.env.ADMIN_USERNAME, password: hash(process.env.ADMIN_PASSWORD), role: 'admin', createdAt: new Date().toISOString() }]); try { const list = JSON.parse(await readFile(modelsFile, 'utf8')); if (!isCurrentCatalog(list)) await save(modelsFile, defaults); } catch { await save(modelsFile, defaults); } }
function session(req) { const value = sessions.get(cookies(req).grok_session); return value?.expires > Date.now() ? value : null; }
function createSession(user) { const token = randomBytes(32).toString('base64url'); sessions.set(token, { username: user.username, role: user.role, expires: Date.now() + 7 * 864e5 }); return token; }
async function readBody(req) { let text = ''; for await (const piece of req) { text += piece; if (text.length > 2_000_000) throw new Error('Request too large'); } return text ? JSON.parse(text) : {}; }
function validConversation(value) { return value && /^[a-zA-Z0-9_-]{8,80}$/.test(value.id) && typeof value.modelId === 'string' && Array.isArray(value.messages) && value.messages.length <= 200 && value.messages.every(x => x && ['user', 'assistant'].includes(x.role) && typeof x.content === 'string' && x.content.length <= 100000); }
function sendDelta(res, text) { if (text) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`); }
function extractResponseText(result) { let text = typeof result?.output_text === 'string' ? result.output_text : ''; if (!text) for (const output of result?.output || []) for (const part of output?.content || []) if (typeof part?.text === 'string') text = part.text; if (!text) return ''; try { return JSON.parse(text).answer || text; } catch { return text; } }
function responsesPayload(messages, model) { return { model, stream: false, input: messages.map(message => ({ role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(message.content || '') }] })), text: { format: { type: 'json_schema', name: 'chat_response', strict: true, schema: { type: 'object', properties: { answer: { type: 'string', description: 'The helpful answer to the user.' }, mood: { type: 'string', description: 'The tone of the answer.' } }, required: ['answer', 'mood'], additionalProperties: false } } } }; }
async function bridgeResponsesStream(upstream, res, model) { const reader = upstream.body.getReader(), decoder = new TextDecoder(); let buffer = '', emitted = false;
  const consume = line => { if (!line.startsWith('data: ')) return; const raw = line.slice(6); if (raw === '[DONE]') return; try { const event = JSON.parse(raw); const text = typeof event.delta === 'string' ? event.delta : event.type === 'response.output_text.done' ? event.text : ''; if (text) { emitted = true; sendDelta(res, text); } } catch {} };
  try { while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(consume); } buffer += decoder.decode(); consume(buffer); } finally { reader.releaseLock(); }
  if (!emitted) console.error(`[chat] no text delta received from KIE model=${model}`); res.end('data: [DONE]\n\n');
}
async function chat(req, res) {
  if (!process.env.KIE_API_KEY) return json(res, 503, { error: 'KIE_API_KEY is missing on the server.' });
  const payload = await readBody(req), selected = (await models()).find(x => x.id === payload.modelId);
  if (!selected || !Array.isArray(payload.messages) || !payload.messages.length) return json(res, 400, { error: 'Choose a valid model and send messages.' });
  const endpoint = `${apiBase}${selected.endpoint}`;
  console.log(`[chat] requesting protocol=responses model=${selected.id}`);
  const upstream = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${process.env.KIE_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(responsesPayload(payload.messages, selected.id)) });
  const contentType = upstream.headers.get('content-type') || '';
  console.log(`[chat] model=${selected.id} status=${upstream.status} content-type=${contentType}`);
  if (!upstream.ok || !upstream.body) { const detail = await upstream.text(); console.error(`[chat] upstream error model=${selected.id}: ${detail.slice(0, 1000)}`); return json(res, upstream.status, { error: `KIE request failed (${upstream.status}): ${detail}` }); }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  if (contentType.includes('text/event-stream')) return bridgeResponsesStream(upstream, res, selected.id);
  const result = await upstream.json().catch(() => null), text = extractResponseText(result);
  if (text) sendDelta(res, text); else { console.error(`[chat] unexpected Responses JSON model=${selected.id}: ${JSON.stringify(result).slice(0, 1000)}`); sendDelta(res, 'KIE returned no readable text. Check server logs.'); }
  res.end('data: [DONE]\n\n');
}
async function staticFile(res, pathname) { const file = pathname === '/' ? '/index.html' : pathname; if (!/^\/[a-zA-Z0-9._/-]+$/.test(file) || file.includes('..')) return json(res, 404, { error: 'Not found' }); try { const content = await readFile(join(root, 'public', file)); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(content); } catch { json(res, 404, { error: 'Not found' }); } }
await bootstrap();
http.createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host}`), active = session(req);
  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user: active?.username || null, isAdmin: active?.role === 'admin' });
  if (req.method === 'GET' && url.pathname === '/api/models') return json(res, 200, { models: await models() });
  if (req.method === 'GET' && url.pathname === '/api/conversations') { if (!active) return json(res, 401, { error: 'Sign in first.' }); const list = (await conversations()).filter(x => x.username === active.username).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); return json(res, 200, { conversations: list }); }
  if (req.method === 'PUT' && url.pathname === '/api/conversations') { if (!active) return json(res, 401, { error: 'Sign in first.' }); const conversation = await readBody(req); if (!validConversation(conversation)) return json(res, 400, { error: 'Invalid conversation.' }); const all = await conversations(), now = new Date().toISOString(), title = conversation.messages.find(x => x.role === 'user')?.content.slice(0, 60) || 'New chat'; const item = { id: conversation.id, username: active.username, title, modelId: conversation.modelId, messages: conversation.messages, createdAt: conversation.createdAt || now, updatedAt: now }; const index = all.findIndex(x => x.id === item.id && x.username === active.username); if (index >= 0) all[index] = item; else all.push(item); await save(conversationsFile, all); return json(res, 200, { conversation: item }); }
  if (req.method === 'POST' && url.pathname === '/api/login') { const { username, password } = await readBody(req), user = (await users()).find(x => x.username === username); if (!user || !validPassword(String(password || ''), user.password)) return json(res, 401, { error: 'Invalid username or password.' }); const token = createSession(user); res.setHeader('set-cookie', `grok_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`); return json(res, 200, { user: user.username }); }
  if (req.method === 'POST' && url.pathname === '/api/logout') { sessions.delete(cookies(req).grok_session); res.setHeader('set-cookie', 'grok_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/chat') { if (!active) return json(res, 401, { error: 'Sign in first.' }); return chat(req, res); }
  return staticFile(res, url.pathname);
} catch (error) { json(res, 500, { error: error instanceof Error ? error.message : 'Server error' }); } }).listen(port, '0.0.0.0', () => console.log(`Grok Desk listening on ${port}`));
